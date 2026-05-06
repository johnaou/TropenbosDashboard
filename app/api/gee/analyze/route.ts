import { getEE, toEEPolygon, evaluate, getMapId, getThumbUrl, type LngLat } from '@/lib/gee'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Body = {
  polygon: LngLat[]
  /** Single date around which a ±45-day window is built. ISO YYYY-MM-DD. */
  date?: string
  /** Scene-level cloud-cover threshold. Defaults to 80 (very permissive — per-pixel masking handles the rest). */
  cloudPct?: number
  treeThreshold?: number
}

// 13-color palette from the new template (white → tan → green ramp).
const PALETTE = [
  'FFFFFF', 'CE7E45', 'DF923D', 'F1B555', 'FCD163',
  '99B718', '74A901', '66A000', '529400', '3E8601',
  '207401', '056201', '004C00',
]

/**
 * Per-pixel cloud + cirrus mask using Sentinel-2 QA60 bits.
 *   bit 10 = opaque clouds, bit 11 = cirrus.
 * A pixel is kept only when both bits are 0.
 */
function maskS2Clouds(ee: any) {
  return (image: any) => {
    const qa = image.select('QA60')
    const cloudBit = 1 << 10
    const cirrusBit = 1 << 11
    const mask = qa.bitwiseAnd(cloudBit).eq(0)
      .and(qa.bitwiseAnd(cirrusBit).eq(0))
    return image.updateMask(mask)
  }
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
    date = '2020-06-01',
    cloudPct = 80,
    treeThreshold = 0.4,
  } = body

  try {
    const { ee } = await getEE()
    const region = toEEPolygon(ee, polygon)

    // ±45-day window around the chosen date.
    const center = ee.Date(date)
    const startDate = center.advance(-45, 'day')
    const endDate = center.advance(45, 'day')

    const s2 = ee
      .ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
      .filterBounds(region)
      .filterDate(startDate, endDate)
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', cloudPct))
      .map(maskS2Clouds(ee))

    const withNdvi = s2.map((img: any) =>
      img.addBands(img.normalizedDifference(['B8', 'B4']).rename('ndvi'))
    )

    const rgb = s2.median().clip(region)
    const ndvi = withNdvi.median().select('ndvi').clip(region)
    const treeMask = ndvi.gt(treeThreshold).selfMask()

    const rgbVis = { min: 0, max: 3000, bands: ['B4', 'B3', 'B2'] }
    const ndviVis = { min: 0, max: 0.8, palette: PALETTE }
    // Dark green; visual opacity (0.25) is applied on the Leaflet TileLayer.
    const treeVis = { palette: ['006400'] }

    const [rgbMap, ndviMap, treeMap, ndviThumbUrl] = await Promise.all([
      getMapId(rgb, rgbVis),
      getMapId(ndvi, ndviVis),
      getMapId(treeMask, treeVis),
      getThumbUrl(ndvi, {
        dimensions: 800,
        region: region,
        format: 'png',
        min: 0,
        max: 0.8,
        palette: PALETTE,
        bands: ['ndvi'],
      }),
    ])

    // Stats: tree area (ha), polygon area (ha), coverage %, image count
    const pixelArea = ee.Image.pixelArea()
    const treeAreaM2 = pixelArea
      .updateMask(ndvi.gt(treeThreshold))
      .reduceRegion({
        reducer: ee.Reducer.sum(),
        geometry: region,
        scale: 10,
        maxPixels: 1e10,
      })
      .get('area')

    const polyAreaM2 = region.area(1)
    const count = s2.size()

    type Stats = { treeAreaM2: number | null; polyAreaM2: number; count: number }
    const stats = await evaluate<Stats>(
      ee.Dictionary({
        treeAreaM2,
        polyAreaM2,
        count,
      })
    )

    const treeHa = stats.treeAreaM2 ? stats.treeAreaM2 / 10_000 : 0
    const polyHa = stats.polyAreaM2 / 10_000
    const coveragePct = polyHa > 0 ? (treeHa / polyHa) * 100 : 0

    return Response.json({
      tiles: {
        rgb: rgbMap.urlFormat,
        ndvi: ndviMap.urlFormat,
        trees: treeMap.urlFormat,
      },
      thumbs: {
        ndvi: ndviThumbUrl,
      },
      stats: {
        treeAreaHa: Number(treeHa.toFixed(2)),
        polygonAreaHa: Number(polyHa.toFixed(2)),
        treeCoveragePct: Number(coveragePct.toFixed(2)),
        imageCount: stats.count,
      },
      params: { date, windowDays: 45, cloudPct, treeThreshold },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ error: msg }, { status: 500 })
  }
}
