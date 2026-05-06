import { getEE, toEEPolygon, evaluate, type LngLat } from '@/lib/gee'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export type DatasetId =
  | 'S2_NDVI'
  | 'L8_NDVI'
  | 'MODIS_NDVI'
  | 'CHIRPS_PRECIP'
  | 'HANSEN_LOSS'

type Body = {
  polygon: LngLat[]
  dataset: DatasetId
  startDate: string
  endDate: string
}

type Point = { date: string; value: number | null }

function buildSeries(ee: any, dataset: DatasetId, region: any, start: string, end: string) {
  const mean = ee.Reducer.mean()

  const reduceCol = (col: any, band: string, scale: number) => {
    const withValue = col.map((img: any) => {
      const dict = img.select(band).reduceRegion({
        reducer: mean,
        geometry: region,
        scale,
        maxPixels: 1e10,
        bestEffort: true,
      })
      return ee.Feature(null, {
        date: ee.Date(img.get('system:time_start')).format('YYYY-MM-dd'),
        value: dict.get(band),
      })
    })
    return ee.FeatureCollection(withValue)
  }

  switch (dataset) {
    case 'S2_NDVI': {
      // Per-pixel cloud + cirrus mask via QA60 bits, matches the analyze pipeline.
      const maskClouds = (img: any) => {
        const qa = img.select('QA60')
        const mask = qa.bitwiseAnd(1 << 10).eq(0).and(qa.bitwiseAnd(1 << 11).eq(0))
        return img.updateMask(mask)
      }
      const col = ee
        .ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
        .filterBounds(region)
        .filterDate(start, end)
        .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 80))
        .map(maskClouds)
        .map((img: any) => img.addBands(img.normalizedDifference(['B8', 'B4']).rename('ndvi')))
      return reduceCol(col, 'ndvi', 10)
    }
    case 'L8_NDVI': {
      const col = ee
        .ImageCollection('LANDSAT/LC08/C02/T1_L2')
        .filterBounds(region)
        .filterDate(start, end)
        .filter(ee.Filter.lt('CLOUD_COVER', 20))
        .map((img: any) => img.addBands(img.normalizedDifference(['SR_B5', 'SR_B4']).rename('ndvi')))
      return reduceCol(col, 'ndvi', 30)
    }
    case 'MODIS_NDVI': {
      const col = ee
        .ImageCollection('MODIS/061/MOD13Q1')
        .filterBounds(region)
        .filterDate(start, end)
        .map((img: any) => img.select('NDVI').multiply(0.0001).rename('ndvi'))
      return reduceCol(col, 'ndvi', 250)
    }
    case 'CHIRPS_PRECIP': {
      const col = ee
        .ImageCollection('UCSB-CHG/CHIRPS/DAILY')
        .filterBounds(region)
        .filterDate(start, end)
        .map((img: any) => img.select('precipitation').rename('value'))
      return reduceCol(col, 'value', 5000)
    }
    case 'HANSEN_LOSS': {
      // Hansen is a single image with lossyear (1=2001 ... 23=2023). Return annual loss ha.
      const hansen = ee.Image('UMD/hansen/global_forest_change_2023_v1_11')
      const lossYear = hansen.select('lossyear')
      const pixelArea = ee.Image.pixelArea()
      const years = ee.List.sequence(1, 23)
      const features = years.map((y: any) => {
        const yr = ee.Number(y)
        const mask = lossYear.eq(yr)
        const area = pixelArea
          .updateMask(mask)
          .reduceRegion({
            reducer: ee.Reducer.sum(),
            geometry: region,
            scale: 30,
            maxPixels: 1e10,
            bestEffort: true,
          })
          .get('area')
        const date = ee.Date.fromYMD(yr.add(2000), 1, 1).format('YYYY-MM-dd')
        return ee.Feature(null, { date, value: ee.Number(area).divide(10000) })
      })
      return ee.FeatureCollection(features)
    }
  }
}

export async function POST(req: Request) {
  let body: Body
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const { polygon, dataset, startDate, endDate } = body
  if (!dataset || !startDate || !endDate) {
    return Response.json(
      { error: 'dataset, startDate, endDate are required' },
      { status: 400 }
    )
  }

  try {
    const { ee } = await getEE()
    const region = toEEPolygon(ee, polygon)
    const fc = buildSeries(ee, dataset, region, startDate, endDate)

    type FCResp = { features: { properties: Point }[] }
    const raw = await evaluate<FCResp>(fc)

    const series: Point[] = (raw.features || [])
      .map((f) => ({
        date: f.properties.date,
        value:
          f.properties.value === null || f.properties.value === undefined
            ? null
            : Number(f.properties.value),
      }))
      .filter((p) => p.date)
      .sort((a, b) => a.date.localeCompare(b.date))

    return Response.json({ dataset, startDate, endDate, series })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ error: msg }, { status: 500 })
  }
}
