# Rento Call Tracker Backend

Backend API to track call clicks and increment daily counts in Google Sheets.

## Endpoints
- `GET /health`
- `POST /track-call`

## Required env vars
- `GOOGLE_SHEET_ID`
- `GOOGLE_SERVICE_ACCOUNT_JSON`

## Optional env vars
- `GOOGLE_SHEET_TAB` (default: `Sheet1`)
- `LOG_TIMEZONE` (default: `Asia/Kolkata`)

## Local run
```bash
npm install
cp .env.example .env
npm run dev
```

## Render deployment
- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Add env vars from above in Render dashboard.

## Sheet format expected
Header row:
- Column A: `Date`
- Column B: `Calls done`

If date row exists, backend increments `Calls done`; otherwise appends a new row with `1`.
