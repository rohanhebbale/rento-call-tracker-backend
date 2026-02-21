const express = require('express')
const cors = require('cors')
const { google } = require('googleapis')
require('dotenv').config()

const app = express()
app.use(cors())
app.use(express.json({ limit: '256kb' }))

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
