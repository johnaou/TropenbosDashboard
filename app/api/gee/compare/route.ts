import { getEE, toEEPolygon, evaluate, getMapId, getThumbUrl, type LngLat } from '@/lib/gee'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Body = {
  polygon: LngLat[]
  /** Earlier "before" date. ISO YYYY-MM-DD. */
  dateBefore: string
  /** Later "after" date. ISO YYYY-MM-DD. */
  dateAfter: string
  /** ±N days around each date used to build a cloud-free median composite. */
  windowDays?: number
  cloudPct?: number
  treeThreshold?: number
}

// 13-color palette used for both before/after NDVI rasters (matches analyze).
const NDVI_PALETTE = [
  'FFFFFF', 'CE7E45', 'DF923D', 'F1B555', 'FCD163',
  '99B718', '74A901', '66A000', '529400', '3E8601',
  '207401', '056201', '004C00',
]

// Diverging palette for NDVI delta: red (loss) → white (no change) → green (gain).
const DELTA_PALETTE = [
  '7f1d1d', 'b91c1c', 'ef4444', 'fca5a5', 'ffffff',
  '86efac', '22c55e', '15803d', '14532d',
]

// Categorical change palette: 1 = loss (red), 2 = gain (green).
const CHANGE_PALETTE = ['dc2626', '16a34a']

function maskS2Clouds(image: any) {
  const qa = image.select('QA60')
  const mask = qa.bitwiseAnd(1 << 10).eq(0).and(qa.bitwiseAnd(1 << 11).eq(0))
  return image.updateMask(mask)
}

export async function POST(req: Request) {
  let body: Body
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const {
    polygon,
    dateBefore,
    dateAfter,
    windowDays = 45,
    cloudPct = 80,
    treeThreshold = 0.4,
  } = body

  if (!dateBefore || !dateAfter) {
    return Response.json(
      { error: 'dateBefore and dateAfter are required' },
      { status: 400 }
    )
  }

  try {
    const { ee } = await getEE()
    const region = toEEPolygon(ee, polygon)

    // ── Build a ±windowDays median NDVI composite around a single date ──
    const buildComposite = (dateString: string) => {
      const center = ee.Date(dateString)
      const start = center.advance(-windowDays, 'day')
      const end = center.advance(windowDays, 'day')

      const s2 = ee
        .ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
        .filterBounds(region)
        .filterDate(start, end)
        .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', cloudPct))
        .map(maskS2Clouds)

      const withNdvi = s2.map((img: any) =>
        img.addBands(img.normalizedDifference(['B8', 'B4']).rename('ndvi'))
      )

      return {
        ndvi: withNdvi.median().select('ndvi').clip(region),
        count: s2.size(),
      }
    }

    const before = buildComposite(dateBefore)
    const after = buildComposite(dateAfter)

    // ── Continuous delta: after − before ──────────────────────────────────
    const delta = after.ndvi.subtract(before.ndvi).rename('delta')

    // ── Categorical change: was tree → not / was not tree → yes ──────────
    const beforeTrees = before.ndvi.gt(treeThreshold)
    const afterTrees = after.ndvi.gt(treeThreshold)
    const loss = beforeTrees.and(afterTrees.not())
    const gain = beforeTrees.not().and(afterTrees)
    // 1 = loss, 2 = gain. Pixels with no change are masked transparent.
    const change = ee
      .Image(0)
      .where(loss, 1)
      .where(gain, 2)
      .updateMask(loss.or(gain))
      .clip(region)
      .rename('change')

    // ── Vis params ────────────────────────────────────────────────────────
    const beforeVis = { min: 0, max: 0.8, palette: NDVI_PALETTE }
    const afterVis = { min: 0, max: 0.8, palette: NDVI_PALETTE }
    const deltaVis = { min: -0.4, max: 0.4, palette: DELTA_PALETTE }
    const changeVis = { min: 1, max: 2, palette: CHANGE_PALETTE }

    const [beforeMap, afterMap, deltaMap, changeMap, deltaThumbUrl] =
      await Promise.all([
        getMapId(before.ndvi, beforeVis),
        getMapId(after.ndvi, afterVis),
        getMapId(delta, deltaVis),
        getMapId(change, changeVis),
        getThumbUrl(delta, {
          dimensions: 800,
          region: region,
          format: 'png',
          min: -0.4,
          max: 0.4,
          palette: DELTA_PALETTE,
          bands: ['delta'],
        }),
      ])

    // ── Stats: hectares lost / gained, polygon area, scene counts ────────
    const pixelArea = ee.Image.pixelArea()
    const lossM2 = pixelArea
      .updateMask(loss)
      .reduceRegion({
        reducer: ee.Reducer.sum(),
        geometry: region,
        scale: 10,
        maxPixels: 1e10,
      })
      .get('area')
    const gainM2 = pixelArea
      .updateMask(gain)
      .reduceRegion({
        reducer: ee.Reducer.sum(),
        geometry: region,
        scale: 10,
        maxPixels: 1e10,
      })
      .get('area')

    const beforeTreeM2 = pixelArea
      .updateMask(beforeTrees)
      .reduceRegion({
        reducer: ee.Reducer.sum(),
        geometry: region,
        scale: 10,
        maxPixels: 1e10,
      })
      .get('area')
    const afterTreeM2 = pixelArea
      .updateMask(afterTrees)
      .reduceRegion({
        reducer: ee.Reducer.sum(),
        geometry: region,
        scale: 10,
        maxPixels: 1e10,
      })
      .get('area')

    // ── Mean NDVI inside the polygon, before and after ──────────────────
    // Combined reducer gives mean + min + max in a single round-trip.
    const ndviReducer = ee.Reducer.mean()
      .combine({ reducer2: ee.Reducer.min(), sharedInputs: true })
      .combine({ reducer2: ee.Reducer.max(), sharedInputs: true })
    const beforeNdviStats = before.ndvi.reduceRegion({
      reducer: ndviReducer,
      geometry: region,
      scale: 10,
      maxPixels: 1e10,
      bestEffort: true,
    })
    const afterNdviStats = after.ndvi.reduceRegion({
      reducer: ndviReducer,
      geometry: region,
      scale: 10,
      maxPixels: 1e10,
      bestEffort: true,
    })

    const polyM2 = region.area(1)

    type Raw = {
      lossM2: number | null
      gainM2: number | null
      beforeTreeM2: number | null
      afterTreeM2: number | null
      polyM2: number
      beforeCount: number
      afterCount: number
      beforeNdvi: { ndvi_mean: number | null; ndvi_min: number | null; ndvi_max: number | null }
      afterNdvi: { ndvi_mean: number | null; ndvi_min: number | null; ndvi_max: number | null }
    }
    const raw = await evaluate<Raw>(
      ee.Dictionary({
        lossM2,
        gainM2,
        beforeTreeM2,
        afterTreeM2,
        polyM2,
        beforeCount: before.count,
        afterCount: after.count,
        beforeNdvi: beforeNdviStats,
        afterNdvi: afterNdviStats,
      })
    )

    const lossHa = raw.lossM2 ? raw.lossM2 / 10_000 : 0
    const gainHa = raw.gainM2 ? raw.gainM2 / 10_000 : 0
    const beforeTreeHa = raw.beforeTreeM2 ? raw.beforeTreeM2 / 10_000 : 0
    const afterTreeHa = raw.afterTreeM2 ? raw.afterTreeM2 / 10_000 : 0
    const polyHa = raw.polyM2 / 10_000
    const netChangeHa = gainHa - lossHa
    const netPct = beforeTreeHa > 0 ? (netChangeHa / beforeTreeHa) * 100 : 0

    const beforeMean = raw.beforeNdvi?.ndvi_mean ?? null
    const afterMean = raw.afterNdvi?.ndvi_mean ?? null
    const meanNdviDelta =
      beforeMean !== null && afterMean !== null ? afterMean - beforeMean : null

    return Response.json({
      tiles: {
        before: beforeMap.urlFormat,
        after: afterMap.urlFormat,
        delta: deltaMap.urlFormat,
        change: changeMap.urlFormat,
      },
      thumbs: {
        delta: deltaThumbUrl,
      },
      stats: {
        lossHa: Number(lossHa.toFixed(2)),
        gainHa: Number(gainHa.toFixed(2)),
        netChangeHa: Number(netChangeHa.toFixed(2)),
        netChangePct: Number(netPct.toFixed(2)),
        beforeTreeHa: Number(beforeTreeHa.toFixed(2)),
        afterTreeHa: Number(afterTreeHa.toFixed(2)),
        polygonAreaHa: Number(polyHa.toFixed(2)),
        beforeImageCount: raw.beforeCount,
        afterImageCount: raw.afterCount,
        beforeNdviMean: beforeMean !== null ? Number(beforeMean.toFixed(3)) : null,
        afterNdviMean: afterMean !== null ? Number(afterMean.toFixed(3)) : null,
        ndviMeanDelta:
          meanNdviDelta !== null ? Number(meanNdviDelta.toFixed(3)) : null,
        beforeNdviMin: raw.beforeNdvi?.ndvi_min ?? null,
        beforeNdviMax: raw.beforeNdvi?.ndvi_max ?? null,
        afterNdviMin: raw.afterNdvi?.ndvi_min ?? null,
        afterNdviMax: raw.afterNdvi?.ndvi_max ?? null,
      },
      params: { dateBefore, dateAfter, windowDays, cloudPct, treeThreshold },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ error: msg }, { status: 500 })
  }
}
