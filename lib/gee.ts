import 'server-only'

// @google/earthengine ships no types; treat as any.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ee = require('@google/earthengine')

type Ready = { ee: typeof ee }
let readyPromise: Promise<Ready> | null = null

function loadKey(): object {
  const raw = process.env.GEE_SERVICE_ACCOUNT_KEY
  if (!raw) {
    throw new Error(
      'GEE_SERVICE_ACCOUNT_KEY is not set. Paste the full service-account JSON into .env.local.'
    )
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('GEE_SERVICE_ACCOUNT_KEY is not valid JSON.')
  }
}

export function getEE(): Promise<Ready> {
  if (readyPromise) return readyPromise
  readyPromise = new Promise<Ready>((resolve, reject) => {
    const key = loadKey()
    ee.data.authenticateViaPrivateKey(
      key,
      () => {
        ee.initialize(
          null,
          null,
          () => resolve({ ee }),
          (err: unknown) => reject(new Error(`ee.initialize failed: ${String(err)}`))
        )
      },
      (err: unknown) => reject(new Error(`ee.data.authenticate failed: ${String(err)}`))
    )
  }).catch((err) => {
    readyPromise = null
    throw err
  })
  return readyPromise
}

export type LngLat = [number, number]

export function toEEPolygon(ee: any, coords: LngLat[]) {
  if (!Array.isArray(coords) || coords.length < 3) {
    throw new Error('polygon must have at least 3 coordinates as [lng, lat] pairs')
  }
  for (const c of coords) {
    if (
      !Array.isArray(c) ||
      c.length !== 2 ||
      typeof c[0] !== 'number' ||
      typeof c[1] !== 'number'
    ) {
      throw new Error('each coordinate must be a [lng, lat] number pair')
    }
  }
  return ee.Geometry.Polygon([coords])
}

export function evaluate<T>(obj: { evaluate: (cb: (val: T, err?: string) => void) => void }): Promise<T> {
  return new Promise((resolve, reject) => {
    obj.evaluate((val, err) => {
      if (err) reject(new Error(err))
      else resolve(val)
    })
  })
}

export function getMapId(img: any, visParams: object): Promise<{ urlFormat: string }> {
  return new Promise((resolve, reject) => {
    img.getMap(visParams, (map: any, err: string) => {
      if (err) return reject(new Error(err))
      if (!map?.urlFormat) return reject(new Error('getMap returned no urlFormat'))
      resolve({ urlFormat: map.urlFormat })
    })
  })
}

/**
 * getThumbUrl
 * Returns a single-PNG URL of the image clipped to a region. Designed for
 * embedding in static reports (PDFs, exports). Different from getMap, which
 * returns a tile-template URL for live web maps.
 *
 * params should include: dimensions, region, format, plus vis params
 * (min/max/palette or bands).
 */
export function getThumbUrl(img: any, params: object): Promise<string> {
  return new Promise((resolve, reject) => {
    img.getThumbURL(params, (url: string, err: string) => {
      if (err) return reject(new Error(err))
      if (!url) return reject(new Error('getThumbURL returned no url'))
      resolve(url)
    })
  })
}
