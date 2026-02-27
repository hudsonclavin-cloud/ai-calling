# Web App (Next.js App Router)

This is the legal intake web app in `/web`, built with:
- Next.js (App Router) + TypeScript
- Tailwind CSS
- shadcn-style UI components
- lucide-react icons

## Routes
- `/dashboard` KPI cards and chart placeholder
- `/calls` recent calls table with status + practice-area filters
- `/leads/[id]` lead detail, timeline, transcript, summary, suggested next action
- `/settings` firm profile editor

## API Integration
The app uses `NEXT_PUBLIC_API_BASE` and calls:
- `GET /api/calls`
- `GET /api/leads`
- `GET /api/leads/:id`
- `GET /api/settings`
- `POST /api/settings`

API client is in `lib/api.ts`.

If backend endpoints are unavailable, the app automatically falls back to mock data from `lib/mock-data.ts` while keeping the API interface stable.

## Setup
1. Install dependencies:
```bash
cd web
npm install
```

2. Create `.env.local`:
```bash
NEXT_PUBLIC_API_BASE=http://127.0.0.1:5050
```

3. Run dev server:
```bash
npm run dev
```

4. Open:
- http://localhost:3000/dashboard

## Build Check
```bash
npm run build
```
