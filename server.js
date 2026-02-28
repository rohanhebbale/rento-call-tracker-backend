const express = require('express')
const cors = require('cors')
const { google } = require('googleapis')
const Razorpay = require('razorpay')
const crypto = require('crypto')
require('dotenv').config()

const app = express()
app.use(cors())
app.use(
  express.json({
    limit: '256kb',
    verify: (req, _res, buf) => {
      req.rawBody = buf
    },
  }),
)

const SHEETS_SCOPE = ['https://www.googleapis.com/auth/spreadsheets']

function getIsoDateInTimeZone(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())

  const year = parts.find((p) => p.type === 'year')?.value
  const month = parts.find((p) => p.type === 'month')?.value
  const day = parts.find((p) => p.type === 'day')?.value

  return `${year}-${month}-${day}`
}

function getServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
  if (!raw) {
    throw new Error('Missing GOOGLE_SERVICE_ACCOUNT_JSON env var')
  }

  const parsed = JSON.parse(raw)
  if (typeof parsed.private_key === 'string') {
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n')
  }
  return parsed
}

function getRazorpayClient() {
  const keyId = process.env.RAZORPAY_KEY_ID
  const keySecret = process.env.RAZORPAY_KEY_SECRET

  if (!keyId || !keySecret) {
    throw new Error('Missing Razorpay credentials in env vars')
  }

  return new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  })
}

async function getSheetsClient() {
  const credentials = getServiceAccount()
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: SHEETS_SCOPE,
  })
  return google.sheets({ version: 'v4', auth })
}

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true })
})

app.head('/health', (_req, res) => {
  res.status(200).end()
})

app.get('/payments/key', (_req, res) => {
  const keyId = process.env.RAZORPAY_KEY_ID || ''
  if (!keyId) {
    res.status(500).json({ ok: false, error: 'Missing RAZORPAY_KEY_ID' })
    return
  }
  res.status(200).json({ ok: true, keyId })
})

app.post('/payments/create-order', async (req, res) => {
  try {
    const amountRupees = Number(req.body?.amount || 0)
    const currency = (req.body?.currency || 'INR').toString()

    if (!Number.isFinite(amountRupees) || amountRupees <= 0) {
      res.status(400).json({ ok: false, error: 'Invalid amount' })
      return
    }

    const razorpay = getRazorpayClient()
    const amount = Math.round(amountRupees * 100)

    const order = await razorpay.orders.create({
      amount,
      currency,
      receipt: `rento_${Date.now()}`,
      notes: {
        source: 'rento-web',
      },
    })

    res.status(200).json({
      ok: true,
      order,
      keyId: process.env.RAZORPAY_KEY_ID,
    })
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'Failed to create order' })
  }
})

app.post('/payments/verify', (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {}
    const keySecret = process.env.RAZORPAY_KEY_SECRET

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      res.status(400).json({ ok: false, error: 'Missing payment fields' })
      return
    }

    if (!keySecret) {
      res.status(500).json({ ok: false, error: 'Missing RAZORPAY_KEY_SECRET' })
      return
    }

    const expectedSignature = crypto
      .createHmac('sha256', keySecret)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex')

    const valid = expectedSignature === razorpay_signature

    if (!valid) {
      res.status(400).json({ ok: false, error: 'Signature verification failed' })
      return
    }

    res.status(200).json({ ok: true })
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'Verification failed' })
  }
})

app.post('/payments/webhook', (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET
    if (!webhookSecret) {
      res.status(500).json({ ok: false, error: 'Missing RAZORPAY_WEBHOOK_SECRET' })
      return
    }

    const signature = req.headers['x-razorpay-signature']
    if (!signature || !req.rawBody) {
      res.status(400).json({ ok: false, error: 'Missing webhook signature or raw body' })
      return
    }

    const expected = crypto
      .createHmac('sha256', webhookSecret)
      .update(req.rawBody)
      .digest('hex')

    if (expected !== signature) {
      res.status(400).json({ ok: false, error: 'Invalid webhook signature' })
      return
    }

    res.status(200).json({ ok: true })
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'Webhook error' })
  }
})

app.post('/track-call', async (_req, res) => {
  try {
    const spreadsheetId = process.env.GOOGLE_SHEET_ID
    const sheetName = process.env.GOOGLE_SHEET_TAB || 'Sheet1'
    const timeZone = process.env.LOG_TIMEZONE || 'Asia/Kolkata'

    if (!spreadsheetId) {
      throw new Error('Missing GOOGLE_SHEET_ID env var')
    }

    const sheets = await getSheetsClient()
    const dateKey = getIsoDateInTimeZone(timeZone)
    const range = `${sheetName}!A:B`

    const readResult = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    })

    const rows = readResult.data.values || []
    let matchedRow = -1

    for (let i = 1; i < rows.length; i += 1) {
      if ((rows[i]?.[0] || '').trim() === dateKey) {
        matchedRow = i + 1
        break
      }
    }

    if (matchedRow > 0) {
      const existing = rows[matchedRow - 1]?.[1] || '0'
      const nextCount = (parseInt(existing, 10) || 0) + 1

      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!B${matchedRow}`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [[nextCount]],
        },
      })

      res.status(200).json({ ok: true, date: dateKey, calls: nextCount })
      return
    }

    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[dateKey, 1]],
      },
    })

    res.status(200).json({ ok: true, date: dateKey, calls: 1 })
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || 'Internal error' })
  }
})

const port = process.env.PORT || 8080
app.listen(port, () => {
  console.log(`Call tracker backend listening on port ${port}`)
})
