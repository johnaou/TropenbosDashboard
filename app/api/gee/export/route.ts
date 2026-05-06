import { getEE, toEEPolygon, type LngLat } from '@/lib/gee'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Body = {
  polygon: LngLat[]
  date?: string
  cloudPct?: number
  treeThreshold?: number
  scale?: number
}

function maskS2Clouds(image: any) {
  const qa = image.select('QA60')
  const mask = qa.bitwiseAnd(1 << 10).eq(0).and(qa.bitwiseAnd(1 << 11).eq(0))
  return image.updateMask(mask)
}

function getDownloadURL(img: any, params: object): Promise<string> {
  return new Promise((resolve, reject) => {
    img.getDownloadURL(params, (url: string, err: string) => {
      if (err) return reject(new Error(err))
      if (!url) return reject(new Error('getDownloadURL returned no url'))
      resolve(url)
    })
  })
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
    scale = 10,
  } = body

  try {
    const { ee } = await getEE()
    const region = toEEPolygon(ee, polygon)

    const center = ee.Date(date)
    const startDate = center.advance(-45, 'day')
    const endDate = center.advance(45, 'day')

    const s2 = ee
      .ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
      .filterBounds(region)
      .filterDate(startDate, endDate)
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', cloudPct))
      .map(maskS2Clouds)

    const ndvi = s2
      .map((img: any) => img.normalizedDifference(['B8', 'B4']).rename('ndvi'))
      .median()
      .clip(region)

    const treeMask = ndvi.gt(treeThreshold).selfMask().toFloat()

    const url = await getDownloadURL(treeMask, {
      name: `tree_mask_${date}`,
      scale,
      region,
      format: 'GEO_TIFF',
      maxPixels: 1e10,
    })

    return Response.json({
      url,
      params: { date, windowDays: 45, cloudPct, treeThreshold, scale },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ error: msg }, { status: 500 })
  }
}
