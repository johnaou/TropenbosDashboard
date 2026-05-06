This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Google Earth Engine Backend

The `/map` page has GEE-powered analysis and time-series endpoints backed by a service account.

**Setup (one-time):**

1. In Google Cloud Console → IAM → Service Accounts, open `tropenbos-service-account`, then ⋮ → **Manage keys → Add key → Create new key → JSON**. Download the JSON file.
2. Register the service account for Earth Engine at https://signup.earthengine.google.com/#!/service_accounts.
3. Copy `.env.local.example` to `.env.local` and paste the **entire JSON** (as one line) into the `GEE_SERVICE_ACCOUNT_KEY=` variable. `.env.local` is gitignored by Next.js.
4. Restart `npm run dev`.

**Endpoints:**

- `POST /api/gee/analyze` — body: `{ polygon: [[lng,lat],...], startDate?, endDate?, cloudPct?, treeThreshold? }`. Returns tile URLs for RGB/NDVI/tree-mask + area stats.
- `POST /api/gee/timeseries` — body: `{ polygon, dataset, startDate, endDate }` where `dataset` ∈ `S2_NDVI | L8_NDVI | MODIS_NDVI | CHIRPS_PRECIP | HANSEN_LOSS`.
- `POST /api/gee/export` — same shape as analyze; returns a GeoTIFF download URL for the tree mask.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
