'use client'

import { useEffect, useRef, useState } from 'react'
import {
  MapContainer,
  TileLayer,
  useMap,
  useMapEvents,
  Polyline,
  Polygon,
  Rectangle,
  Marker,
} from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from 'recharts'

// ─── Custom pin icon for vertex markers ───────────────────────────────────────
// Inline SVG via DivIcon so we don't depend on Leaflet's default icon assets
// (which break under most bundlers). Pin point is at the bottom-center.
const pinIcon = L.divIcon({
  className: 'tb-pin',
  html: `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="30" viewBox="0 0 22 30" fill="none">
    <path d="M11 0C5.477 0 1 4.477 1 10c0 7.5 10 19 10 19s10-11.5 10-19c0-5.523-4.477-10-10-10z"
      fill="#18181b" stroke="#ffffff" stroke-width="1.25"/>
    <circle cx="11" cy="10" r="3.25" fill="#ffffff"/>
  </svg>`,
  iconSize: [22, 30],
  iconAnchor: [11, 29],
  popupAnchor: [0, -28],
})

// ─── Types ────────────────────────────────────────────────────────────────────

type Point = { lat: number; lng: number }

type NominatimResult = {
  display_name: string
  lat: string
  lon: string
}

type ImportedPolygon = {
  id: string
  title: string
  points: Point[]
  visible: boolean
}

type DatasetId = 'S2_NDVI' | 'L8_NDVI' | 'MODIS_NDVI' | 'CHIRPS_PRECIP' | 'HANSEN_LOSS'

const DATASETS: { id: DatasetId; label: string; unit: string }[] = [
  { id: 'S2_NDVI', label: 'Sentinel-2 NDVI (10m)', unit: 'NDVI' },
  { id: 'L8_NDVI', label: 'Landsat 8 NDVI (30m)', unit: 'NDVI' },
  { id: 'MODIS_NDVI', label: 'MODIS NDVI (250m)', unit: 'NDVI' },
  { id: 'CHIRPS_PRECIP', label: 'CHIRPS Precipitation', unit: 'mm/day' },
  { id: 'HANSEN_LOSS', label: 'Hansen Annual Forest Loss', unit: 'hectares' },
]

type GeeTiles = { rgb: string; ndvi: string; trees: string }
type GeeStats = {
  treeAreaHa: number
  polygonAreaHa: number
  treeCoveragePct: number
  imageCount: number
}
type TSPoint = { date: string; value: number | null }

type CompareTiles = {
  before: string
  after: string
  delta: string
  change: string
}
type CompareStats = {
  lossHa: number
  gainHa: number
  netChangeHa: number
  netChangePct: number
  beforeTreeHa: number
  afterTreeHa: number
  polygonAreaHa: number
  beforeImageCount: number
  afterImageCount: number
  beforeNdviMean: number | null
  afterNdviMean: number | null
  ndviMeanDelta: number | null
  beforeNdviMin: number | null
  beforeNdviMax: number | null
  afterNdviMin: number | null
  afterNdviMax: number | null
}

// NDVI color key — matches the 13-color palette used by the analyze route.
const NDVI_KEY: { color: string; label: string }[] = [
  { color: 'FFFFFF', label: '0.00 — no vegetation' },
  { color: 'CE7E45', label: '0.05' },
  { color: 'DF923D', label: '0.10' },
  { color: 'F1B555', label: '0.15' },
  { color: 'FCD163', label: '0.20' },
  { color: '99B718', label: '0.25' },
  { color: '74A901', label: '0.30' },
  { color: '66A000', label: '0.35' },
  { color: '529400', label: '0.40 — moderate' },
  { color: '3E8601', label: '0.45' },
  { color: '207401', label: '0.50' },
  { color: '056201', label: '0.60' },
  { color: '004C00', label: '0.70+ — dense' },
]

// ─── Map sub-components ───────────────────────────────────────────────────────

function SetView({ center, zoom }: { center: [number, number]; zoom: number }) {
  const map = useMap()
  useEffect(() => {
    map.setView(center, zoom)
  }, [center, zoom, map])
  return null
}

function FlyToLocation({
  target,
}: {
  target: { center: [number, number]; zoom: number } | null
}) {
  const map = useMap()
  useEffect(() => {
    if (!target) return
    map.flyTo(target.center, target.zoom, { duration: 1.4 })
  }, [target, map])
  return null
}

function ClickToAddPoints({
  drawing,
  points,
  setPoints,
}: {
  drawing: boolean
  points: Point[]
  setPoints: React.Dispatch<React.SetStateAction<Point[]>>
}) {
  useMapEvents({
    click(e) {
      if (!drawing) return
      setPoints([...points, { lat: e.latlng.lat, lng: e.latlng.lng }])
    },
  })
  return null
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pointsEqual(a: Point, b: Point) {
  return a.lat === b.lat && a.lng === b.lng
}

function parseCSV(raw: string): { polygons: ImportedPolygon[]; errors: string[] } {
  const polygons: ImportedPolygon[] = []
  const errors: string[] = []

  const lines = raw.trim().split('\n')
  if (lines.length < 2) {
    return { polygons: [], errors: ['CSV appears to be empty or missing a header row.'] }
  }

  const header = lines[0]
    .replace(/^\uFEFF/, '')
    .split(',')
    .map((h) => h.trim().replace(/^"|"$/g, '').toLowerCase())

  const titleIdx = header.indexOf('title')
  const edgesIdx = header.indexOf('edges')

  if (edgesIdx === -1) {
    return { polygons: [], errors: ['Could not find an "Edges" column in the CSV header.'] }
  }

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    const cols = splitCSVLine(line)

    const title =
      titleIdx !== -1 && cols[titleIdx]
        ? cols[titleIdx].replace(/^"|"$/g, '').trim() || `Polygon ${i}`
        : `Polygon ${i}`

    const edgesRaw = cols[edgesIdx]?.replace(/^"|"$/g, '').trim()
    if (!edgesRaw) {
      errors.push(`Row ${i}: Edges column is empty — skipped.`)
      continue
    }

    const points: Point[] = []
    for (const pair of edgesRaw.split(',')) {
      const [latStr, lngStr] = pair.trim().split('|')
      const lat = parseFloat(latStr)
      const lng = parseFloat(lngStr)
      if (isNaN(lat) || isNaN(lng)) {
        errors.push(`Row ${i} ("${title}"): skipped malformed coordinate "${pair}".`)
        continue
      }
      points.push({ lat, lng })
    }

    if (points.length < 3) {
      errors.push(`Row ${i} ("${title}"): fewer than 3 valid points — skipped.`)
      continue
    }

    polygons.push({
      id: `imported-${i}-${Date.now()}`,
      title,
      points,
      visible: true,
    })
  }

  return { polygons, errors }
}

function splitCSVLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      inQuotes = !inQuotes
      current += ch
    } else if (ch === ',' && !inQuotes) {
      result.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  result.push(current)
  return result
}

function centroid(points: Point[]): [number, number] {
  const lat = points.reduce((s, p) => s + p.lat, 0) / points.length
  const lng = points.reduce((s, p) => s + p.lng, 0) / points.length
  return [lat, lng]
}

// ─── Reusable rail bits ───────────────────────────────────────────────────────

function Section({
  label,
  defaultOpen = false,
  children,
}: {
  label: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  return (
    <details
      open={defaultOpen}
      className="group border-b border-zinc-200 last:border-b-0"
    >
      <summary className="cursor-pointer list-none px-5 py-3 flex items-center justify-between text-[11px] font-medium uppercase tracking-wider text-zinc-500 hover:text-zinc-900 transition-colors">
        {label}
        <span className="text-zinc-400 group-open:rotate-90 transition-transform">›</span>
      </summary>
      <div className="px-5 pb-4 pt-0">{children}</div>
    </details>
  )
}

const inputCls =
  'w-full bg-white border border-zinc-200 rounded-md px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none focus:ring-1 focus:ring-zinc-900 focus:border-zinc-900'

const btnPrimary =
  'inline-flex items-center justify-center gap-1.5 bg-zinc-900 text-white text-sm px-3 py-2 rounded-md hover:bg-zinc-800 transition-colors disabled:opacity-40 disabled:cursor-not-allowed'

const btnSecondary =
  'inline-flex items-center justify-center gap-1.5 bg-white border border-zinc-200 text-zinc-900 text-sm px-3 py-2 rounded-md hover:bg-zinc-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed'

const btnGhost =
  'inline-flex items-center justify-center gap-1.5 text-zinc-500 hover:text-zinc-900 text-sm px-2 py-1 rounded-md hover:bg-zinc-100 transition-colors'

const labelCls = 'block text-xs text-zinc-500 mb-1'

// ─── Main Component ───────────────────────────────────────────────────────────

export default function FreeDrawMap() {
  const [center, setCenter] = useState<[number, number]>([6.48951, -1.04261])
  const [zoom, setZoom] = useState(13)
  const [flyTarget, setFlyTarget] = useState<{ center: [number, number]; zoom: number } | null>(null)

  // Drawing
  const [drawing, setDrawing] = useState(false)
  const [isFinished, setIsFinished] = useState(false)
  const [points, setPoints] = useState<Point[]>([])
  const [error, setError] = useState('')

  // Search
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<NominatimResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState('')
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Coord input
  const [coordLat, setCoordLat] = useState('')
  const [coordLng, setCoordLng] = useState('')
  const [coordError, setCoordError] = useState('')

  // CSV import
  const [csvText, setCsvText] = useState('')
  const [importedPolygons, setImportedPolygons] = useState<ImportedPolygon[]>([])
  const [importErrors, setImportErrors] = useState<string[]>([])
  const [importSuccess, setImportSuccess] = useState('')
  const [editingImportedId, setEditingImportedId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // GEE
  const [geeTiles, setGeeTiles] = useState<GeeTiles | null>(null)
  const [geeStats, setGeeStats] = useState<GeeStats | null>(null)
  const [geeLoading, setGeeLoading] = useState(false)
  const [geeError, setGeeError] = useState('')
  const [visibleLayers, setVisibleLayers] = useState({ rgb: true, ndvi: false, trees: true })
  const [analysisDate, setAnalysisDate] = useState('2020-06-01')
  const [ndviThumbUrl, setNdviThumbUrl] = useState<string | null>(null)

  // Time series
  const [tsDataset, setTsDataset] = useState<DatasetId>('S2_NDVI')
  const [tsStart, setTsStart] = useState('2020-01-01')
  const [tsEnd, setTsEnd] = useState('2020-12-31')
  const [tsData, setTsData] = useState<TSPoint[] | null>(null)
  const [tsLoading, setTsLoading] = useState(false)
  const [tsError, setTsError] = useState('')

  // Export
  const [exportLoading, setExportLoading] = useState(false)
  const [exportUrl, setExportUrl] = useState('')
  const [exportError, setExportError] = useState('')

  // Compare dates
  const [compareDateBefore, setCompareDateBefore] = useState('2018-06-01')
  const [compareDateAfter, setCompareDateAfter] = useState('2023-06-01')
  const [compareTiles, setCompareTiles] = useState<CompareTiles | null>(null)
  const [compareStats, setCompareStats] = useState<CompareStats | null>(null)
  const [compareLoading, setCompareLoading] = useState(false)
  const [compareError, setCompareError] = useState('')
  const [visibleCompareLayers, setVisibleCompareLayers] = useState({
    change: true,
    delta: false,
    before: false,
    after: false,
  })
  const [deltaThumbUrl, setDeltaThumbUrl] = useState<string | null>(null)

  // Layout: when expanded, the rail takes ~2/3 of the viewport so the analysis
  // and time-series sections have room to breathe; the map shrinks to ~1/3.
  const [expanded, setExpanded] = useState(false)

  // PDF export
  const [pdfLoading, setPdfLoading] = useState(false)
  const chartContainerRef = useRef<HTMLDivElement | null>(null)

  // Geolocation
  useEffect(() => {
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setCenter([position.coords.latitude, position.coords.longitude])
        setZoom(15)
      },
      () => console.log('Location denied, using default location'),
      { enableHighAccuracy: true, timeout: 10000 }
    )
  }, [])

  // ─── Drawing controls ─────────────────────────────────────────────────────

  function startDrawing() {
    setPoints([])
    setDrawing(true)
    setIsFinished(false)
    setError('')
    setEditingImportedId(null)
  }

  function clearDrawing() {
    setPoints([])
    setDrawing(false)
    setIsFinished(false)
    setError('')
    setEditingImportedId(null)
  }

  function undoLastPoint() {
    setError('')
    setPoints((prev) => prev.slice(0, -1))
  }

  function finishDrawing() {
    setError('')
    if (points.length < 3) {
      setError('Place at least 3 points.')
      setIsFinished(false)
      return
    }
    const uniquePoints: Point[] = []
    for (const p of points) {
      if (!uniquePoints.some((q) => pointsEqual(p, q))) uniquePoints.push(p)
    }
    if (uniquePoints.length < 3) {
      setError('Need at least 3 distinct points.')
      setIsFinished(false)
      return
    }
    setDrawing(false)
    setIsFinished(true)
  }

  // ─── CSV import controls ──────────────────────────────────────────────────

  function handleImport() {
    setImportErrors([])
    setImportSuccess('')

    if (!csvText.trim()) {
      setImportErrors(['Paste CSV text above before importing.'])
      return
    }

    const { polygons, errors } = parseCSV(csvText)
    setImportErrors(errors)

    if (polygons.length === 0) {
      setImportErrors((prev) => ['No valid polygons found.', ...prev])
      return
    }

    setImportedPolygons((prev) => [...prev, ...polygons])
    setImportSuccess(`Imported ${polygons.length} polygon${polygons.length > 1 ? 's' : ''}.`)
    setCsvText('')

    const c = centroid(polygons[0].points)
    setFlyTarget({ center: c, zoom: 16 })
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target?.result as string
      setCsvText(text)
      setImportSuccess('')
      setImportErrors([])
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  function togglePolygonVisibility(id: string) {
    setImportedPolygons((prev) =>
      prev.map((p) => (p.id === id ? { ...p, visible: !p.visible } : p))
    )
  }

  function removeImportedPolygon(id: string) {
    setImportedPolygons((prev) => prev.filter((p) => p.id !== id))
    if (editingImportedId === id) clearDrawing()
  }

  function loadForEditing(polygon: ImportedPolygon) {
    setPoints([...polygon.points])
    setDrawing(true)
    setIsFinished(false)
    setError('')
    setEditingImportedId(polygon.id)
    const c = centroid(polygon.points)
    setFlyTarget({ center: c, zoom: 16 })
  }

  function flyToImported(polygon: ImportedPolygon) {
    const c = centroid(polygon.points)
    setFlyTarget({ center: c, zoom: 16 })
  }

  // ─── Search ────────────────────────────────────────────────────────────────

  function handleSearchInput(value: string) {
    setSearchQuery(value)
    setSearchError('')
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    if (!value.trim()) {
      setSearchResults([])
      return
    }
    searchDebounceRef.current = setTimeout(async () => {
      setSearchLoading(true)
      try {
        const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(value)}&format=json&limit=5`
        const res = await fetch(url, { headers: { 'Accept-Language': 'en' } })
        if (!res.ok) throw new Error('Search request failed')
        const data: NominatimResult[] = await res.json()
        setSearchResults(data)
        if (data.length === 0) setSearchError('No results found.')
      } catch {
        setSearchError('Search failed. Check your connection.')
      } finally {
        setSearchLoading(false)
      }
    }, 400)
  }

  function selectSearchResult(result: NominatimResult) {
    const lat = parseFloat(result.lat)
    const lng = parseFloat(result.lon)
    setFlyTarget({ center: [lat, lng], zoom: 14 })
    setSearchQuery(result.display_name)
    setSearchResults([])
    setSearchError('')
  }

  // ─── Coordinate input ─────────────────────────────────────────────────────

  function jumpToCoords() {
    setCoordError('')
    const lat = parseFloat(coordLat)
    const lng = parseFloat(coordLng)
    if (isNaN(lat) || isNaN(lng)) {
      setCoordError('Enter valid numbers for both lat and lng.')
      return
    }
    if (lat < -90 || lat > 90) {
      setCoordError('Latitude must be between -90 and 90.')
      return
    }
    if (lng < -180 || lng > 180) {
      setCoordError('Longitude must be between -180 and 180.')
      return
    }
    setFlyTarget({ center: [lat, lng], zoom: 15 })
    if (drawing) {
      setPoints((prev) => [...prev, { lat, lng }])
    }
  }

  // ─── GEE active polygon + handlers ────────────────────────────────────────

  function getActivePolygon(): { title: string; coords: [number, number][] } | null {
    if (isFinished && points.length >= 3) {
      const ring = [...points, points[0]].map((p) => [p.lng, p.lat] as [number, number])
      return { title: 'Hand-drawn polygon', coords: ring }
    }
    const firstVisible = importedPolygons.find((p) => p.visible)
    if (firstVisible) {
      const ring = [
        ...firstVisible.points,
        firstVisible.points[0],
      ].map((p) => [p.lng, p.lat] as [number, number])
      return { title: firstVisible.title, coords: ring }
    }
    return null
  }

  async function runAnalysis() {
    setGeeError('')
    const active = getActivePolygon()
    if (!active) {
      setGeeError('Draw a polygon or toggle on an imported one first.')
      return
    }
    setExpanded(true)
    setGeeLoading(true)
    setGeeTiles(null)
    setGeeStats(null)
    setNdviThumbUrl(null)
    try {
      const res = await fetch('/api/gee/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ polygon: active.coords, date: analysisDate }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setGeeTiles(json.tiles)
      setGeeStats(json.stats)
      setNdviThumbUrl(json.thumbs?.ndvi ?? null)
    } catch (err) {
      setGeeError(err instanceof Error ? err.message : String(err))
    } finally {
      setGeeLoading(false)
    }
  }

  async function getTimeSeries() {
    setTsError('')
    const active = getActivePolygon()
    if (!active) {
      setTsError('Draw a polygon or toggle on an imported one first.')
      return
    }
    setExpanded(true)
    setTsLoading(true)
    setTsData(null)
    try {
      const res = await fetch('/api/gee/timeseries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          polygon: active.coords,
          dataset: tsDataset,
          startDate: tsStart,
          endDate: tsEnd,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setTsData(json.series as TSPoint[])
    } catch (err) {
      setTsError(err instanceof Error ? err.message : String(err))
    } finally {
      setTsLoading(false)
    }
  }

  async function runCompare() {
    setCompareError('')
    const active = getActivePolygon()
    if (!active) {
      setCompareError('Draw a polygon or toggle on an imported one first.')
      return
    }
    if (!compareDateBefore || !compareDateAfter) {
      setCompareError('Pick both a before and an after date.')
      return
    }
    if (compareDateBefore >= compareDateAfter) {
      setCompareError('Before date must be earlier than after date.')
      return
    }
    setExpanded(true)
    setCompareLoading(true)
    setCompareTiles(null)
    setCompareStats(null)
    setDeltaThumbUrl(null)
    try {
      const res = await fetch('/api/gee/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          polygon: active.coords,
          dateBefore: compareDateBefore,
          dateAfter: compareDateAfter,
        }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setCompareTiles(json.tiles)
      setCompareStats(json.stats)
      setDeltaThumbUrl(json.thumbs?.delta ?? null)
    } catch (err) {
      setCompareError(err instanceof Error ? err.message : String(err))
    } finally {
      setCompareLoading(false)
    }
  }

  async function exportPdf() {
    setPdfLoading(true)
    try {
      const { generatePdfReport, svgToPng } = await import('@/lib/pdf')

      const active = getActivePolygon()
      const datasetMeta = DATASETS.find((d) => d.id === tsDataset)

      const chartImage = tsData
        ? (await svgToPng(chartContainerRef.current)) ?? undefined
        : undefined

      const doc = await generatePdfReport({
        polygon: active,
        analysis: geeStats
          ? {
              date: analysisDate,
              cloudPct: 80,
              treeThreshold: 0.4,
              windowDays: 45,
              stats: geeStats,
              ndviThumbUrl: ndviThumbUrl ?? undefined,
            }
          : undefined,
        compare: compareStats
          ? {
              dateBefore: compareDateBefore,
              dateAfter: compareDateAfter,
              windowDays: 45,
              cloudPct: 80,
              treeThreshold: 0.4,
              stats: compareStats,
              deltaThumbUrl: deltaThumbUrl ?? undefined,
            }
          : undefined,
        timeSeries: tsData
          ? {
              datasetLabel: datasetMeta?.label ?? tsDataset,
              unit: datasetMeta?.unit ?? '',
              startDate: tsStart,
              endDate: tsEnd,
              series: tsData,
              chartImage,
            }
          : undefined,
      })

      const slug = active?.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'report'
      const stamp = new Date().toISOString().slice(0, 10)
      doc.save(`tropenbos-${slug}-${stamp}.pdf`)
    } catch (err) {
      console.error(err)
      alert(
        `PDF export failed: ${err instanceof Error ? err.message : String(err)}`
      )
    } finally {
      setPdfLoading(false)
    }
  }

  async function exportGeoTIFF() {
    setExportError('')
    setExportUrl('')
    const active = getActivePolygon()
    if (!active) {
      setExportError('Draw a polygon or toggle on an imported one first.')
      return
    }
    setExportLoading(true)
    try {
      const res = await fetch('/api/gee/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ polygon: active.coords, date: analysisDate }),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setExportUrl(json.url)
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err))
    } finally {
      setExportLoading(false)
    }
  }

  // ─── Derived polygon data ─────────────────────────────────────────────────

  const closedPoints =
    isFinished && points.length >= 3 ? [...points, points[0]] : points

  const bounds =
    isFinished && points.length > 0
      ? {
          minLat: Math.min(...points.map((p) => p.lat)),
          maxLat: Math.max(...points.map((p) => p.lat)),
          minLng: Math.min(...points.map((p) => p.lng)),
          maxLng: Math.max(...points.map((p) => p.lng)),
        }
      : null

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="h-full flex">
      {/* ── Left rail ────────────────────────────────────────────────────── */}
      <aside
        className={`shrink-0 border-r border-zinc-200 bg-white overflow-y-auto rail-scroll flex flex-col transition-[width] duration-200 ease-out ${
          expanded ? 'w-2/3' : 'w-[360px]'
        }`}
      >
        {/* Expand / collapse + export PDF */}
        <div className="px-5 py-2 flex items-center justify-between border-b border-zinc-200 bg-white sticky top-0 z-10">
          <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            {expanded ? 'Analysis view' : 'Controls'}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={exportPdf}
              disabled={pdfLoading}
              className={btnGhost}
              title="Export current results as PDF"
            >
              {pdfLoading ? 'Building…' : 'Export PDF'}
            </button>
            <button
              onClick={() => setExpanded((v) => !v)}
              className={btnGhost}
              title={expanded ? 'Collapse panel' : 'Expand for analysis'}
            >
              {expanded ? '⟨ Collapse' : 'Expand ⟩'}
            </button>
          </div>
        </div>

        <Section label="Search" defaultOpen>
          <div className="relative">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => handleSearchInput(e.target.value)}
              placeholder="City, landmark, address…"
              className={inputCls}
            />
            {searchLoading && (
              <span className="absolute right-3 top-2 text-zinc-400 text-xs">
                Searching…
              </span>
            )}
            {searchResults.length > 0 && (
              <ul className="absolute z-[1000] bg-white border border-zinc-200 rounded-md shadow-sm w-full mt-1 max-h-48 overflow-y-auto text-sm">
                {searchResults.map((r, i) => (
                  <li
                    key={i}
                    className="px-3 py-2 cursor-pointer hover:bg-zinc-50 truncate text-zinc-900"
                    onClick={() => selectSearchResult(r)}
                    title={r.display_name}
                  >
                    {r.display_name}
                  </li>
                ))}
              </ul>
            )}
          </div>
          {searchError && <p className="text-red-600 text-xs mt-2">{searchError}</p>}
        </Section>

        <Section label="Jump to coordinates">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelCls}>Latitude</label>
              <input
                type="number"
                value={coordLat}
                onChange={(e) => setCoordLat(e.target.value)}
                placeholder="6.4895"
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>Longitude</label>
              <input
                type="number"
                value={coordLng}
                onChange={(e) => setCoordLng(e.target.value)}
                placeholder="-1.0426"
                className={inputCls}
              />
            </div>
          </div>
          <button onClick={jumpToCoords} className={`${btnSecondary} w-full mt-2`}>
            {drawing ? 'Go and add point' : 'Go to location'}
          </button>
          {coordError && <p className="text-red-600 text-xs mt-2">{coordError}</p>}
          {drawing && (
            <p className="text-zinc-400 text-xs mt-2">
              While drawing, this also adds a vertex.
            </p>
          )}
        </Section>

        <Section label="Draw polygon" defaultOpen>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={startDrawing} className={btnPrimary}>
              Start
            </button>
            <button onClick={finishDrawing} className={btnSecondary}>
              Done
            </button>
            <button
              onClick={undoLastPoint}
              className={btnSecondary}
              disabled={points.length === 0}
            >
              Undo
            </button>
            <button onClick={clearDrawing} className={btnSecondary}>
              Clear
            </button>
          </div>
          {drawing && (
            <p className="mt-2 text-xs text-zinc-500">
              {editingImportedId
                ? 'Editing imported polygon. Click map to add vertices.'
                : 'Click on the map to place vertices.'}
            </p>
          )}
          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
          {points.length > 0 && (
            <p className="mt-2 text-xs text-zinc-400">{points.length} vertices</p>
          )}
        </Section>

        <Section label="Import CSV">
          <p className="text-xs text-zinc-500 mb-2">
            Columns: <span className="font-mono text-zinc-700">Title</span> and{' '}
            <span className="font-mono text-zinc-700">Edges</span> (
            <span className="font-mono">lat|lng,…</span>).
          </p>

          <div className="flex items-center gap-2 mb-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              className={btnSecondary}
            >
              Choose file
            </button>
            <span className="text-xs text-zinc-400">or paste below</span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={handleFileUpload}
              className="hidden"
            />
          </div>

          <textarea
            value={csvText}
            onChange={(e) => {
              setCsvText(e.target.value)
              setImportSuccess('')
              setImportErrors([])
            }}
            placeholder={`Title,Edges\n"Plot A","5.7517|-0.1947,5.7516|-0.1948,5.7515|-0.1946"`}
            rows={4}
            className={`${inputCls} font-mono text-xs`}
          />

          <button onClick={handleImport} className={`${btnPrimary} w-full mt-2`}>
            Import
          </button>

          {importSuccess && (
            <p className="text-emerald-700 text-xs mt-2">{importSuccess}</p>
          )}
          {importErrors.length > 0 && (
            <ul className="mt-2 space-y-1">
              {importErrors.map((e, i) => (
                <li key={i} className="text-red-600 text-xs">
                  {e}
                </li>
              ))}
            </ul>
          )}
        </Section>

        {importedPolygons.length > 0 && (
          <Section label={`Imported (${importedPolygons.length})`} defaultOpen>
            <ul className="-mx-2">
              {importedPolygons.map((poly) => (
                <li
                  key={poly.id}
                  className="flex items-center gap-2 px-2 py-2 hover:bg-zinc-50 rounded-md"
                >
                  <button
                    onClick={() => togglePolygonVisibility(poly.id)}
                    title={poly.visible ? 'Hide' : 'Show'}
                    className={`shrink-0 w-7 h-4 rounded-full transition-colors relative ${
                      poly.visible ? 'bg-zinc-900' : 'bg-zinc-200'
                    }`}
                  >
                    <span
                      className="block w-3 h-3 bg-white rounded-full absolute top-0.5 transition-all shadow-sm"
                      style={{ left: poly.visible ? '14px' : '2px' }}
                    />
                  </button>

                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-zinc-900 truncate">{poly.title}</p>
                    <p className="text-[10px] text-zinc-400">{poly.points.length} vertices</p>
                  </div>

                  <div className="flex gap-0.5 shrink-0">
                    <button onClick={() => flyToImported(poly)} className={btnGhost}>
                      Locate
                    </button>
                    <button
                      onClick={() => loadForEditing(poly)}
                      className={`${btnGhost} ${
                        editingImportedId === poly.id ? 'text-zinc-900' : ''
                      }`}
                    >
                      {editingImportedId === poly.id ? 'Editing' : 'Edit'}
                    </button>
                    <button
                      onClick={() => removeImportedPolygon(poly.id)}
                      className={btnGhost}
                      title="Remove"
                    >
                      ✕
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <button
              onClick={() => setImportedPolygons([])}
              className={`${btnGhost} mt-1`}
            >
              Clear all
            </button>
          </Section>
        )}

        <Section label="Earth Engine analysis" defaultOpen>
          <p className="text-xs text-zinc-500 mb-3">
            Sentinel-2 ± 45 days around the chosen date. Per-pixel cloud + cirrus
            mask via QA60. NDVI threshold 0.4 for tree mask.
          </p>

          <div className="mb-2">
            <label className={labelCls}>Date</label>
            <input
              type="date"
              value={analysisDate}
              onChange={(e) => setAnalysisDate(e.target.value)}
              className={inputCls}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={runAnalysis}
              disabled={geeLoading}
              className={btnPrimary}
            >
              {geeLoading ? 'Running…' : 'Run analysis'}
            </button>
            <button
              onClick={exportGeoTIFF}
              disabled={exportLoading}
              className={btnSecondary}
            >
              {exportLoading ? 'Preparing…' : 'Export TIFF'}
            </button>
          </div>

          {geeError && <p className="mt-2 text-xs text-red-600">{geeError}</p>}
          {exportError && (
            <p className="mt-2 text-xs text-red-600">Export: {exportError}</p>
          )}
          {exportUrl && (
            <p className="mt-2 text-xs">
              <a
                href={exportUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-zinc-900 underline underline-offset-2 hover:text-zinc-600"
              >
                Download tree-mask GeoTIFF ↓
              </a>
            </p>
          )}

          {geeStats && (
            <div
              className={`mt-3 grid gap-px bg-zinc-200 border border-zinc-200 rounded-md overflow-hidden ${
                expanded ? 'grid-cols-4' : 'grid-cols-2'
              }`}
            >
              {[
                { label: 'Polygon', value: `${geeStats.polygonAreaHa} ha` },
                { label: 'Trees', value: `${geeStats.treeAreaHa} ha` },
                { label: 'Coverage', value: `${geeStats.treeCoveragePct}%` },
                { label: 'Scenes', value: String(geeStats.imageCount) },
              ].map((s) => (
                <div key={s.label} className="bg-white px-3 py-2">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-400">
                    {s.label}
                  </div>
                  <div className="text-sm font-medium text-zinc-900 mt-0.5">
                    {s.value}
                  </div>
                </div>
              ))}
            </div>
          )}

          {geeTiles && (
            <div className="mt-3 space-y-1.5">
              {(['rgb', 'ndvi', 'trees'] as const).map((key) => (
                <label
                  key={key}
                  className="flex items-center gap-2 text-xs text-zinc-700 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={visibleLayers[key]}
                    onChange={(e) =>
                      setVisibleLayers((v) => ({ ...v, [key]: e.target.checked }))
                    }
                    className="accent-zinc-900"
                  />
                  <span>
                    {key === 'rgb'
                      ? 'Satellite RGB'
                      : key === 'ndvi'
                      ? 'NDVI'
                      : 'Tree mask'}
                  </span>
                </label>
              ))}
            </div>
          )}

          {geeTiles && visibleLayers.ndvi && (
            <div className="mt-3 border border-zinc-200 rounded-md p-2.5">
              <div className="text-[10px] uppercase tracking-wider text-zinc-400 mb-1.5">
                NDVI key
              </div>
              <ul className="space-y-1">
                {NDVI_KEY.map((row) => (
                  <li key={row.color} className="flex items-center gap-2">
                    <span
                      className="w-4 h-3 border border-zinc-300 shrink-0"
                      style={{ backgroundColor: `#${row.color}` }}
                    />
                    <span className="text-[11px] text-zinc-700">{row.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Section>

        <Section label="Compare dates">
          <p className="text-xs text-zinc-500 mb-3">
            Compares NDVI between two dates (each a ±45-day median composite).
            Shows tree loss (red) and gain (green) where the NDVI 0.4 threshold
            was crossed.
          </p>

          <div className="grid grid-cols-2 gap-2 mb-2">
            <div>
              <label className={labelCls}>Before</label>
              <input
                type="date"
                value={compareDateBefore}
                onChange={(e) => setCompareDateBefore(e.target.value)}
                className={inputCls}
              />
            </div>
            <div>
              <label className={labelCls}>After</label>
              <input
                type="date"
                value={compareDateAfter}
                onChange={(e) => setCompareDateAfter(e.target.value)}
                className={inputCls}
              />
            </div>
          </div>

          <button
            onClick={runCompare}
            disabled={compareLoading}
            className={`${btnPrimary} w-full`}
          >
            {compareLoading ? 'Comparing…' : 'Run comparison'}
          </button>

          {compareError && (
            <p className="mt-2 text-xs text-red-600">{compareError}</p>
          )}

          {compareStats && (
            <>
              <div className="mt-3 text-[10px] uppercase tracking-wider text-zinc-400">
                Tree cover (NDVI &gt; 0.4)
              </div>
              <div
                className={`mt-1 grid gap-px bg-zinc-200 border border-zinc-200 rounded-md overflow-hidden ${
                  expanded ? 'grid-cols-4' : 'grid-cols-2'
                }`}
              >
                {[
                  { label: 'Loss', value: `${compareStats.lossHa} ha`, accent: 'text-red-700' },
                  { label: 'Gain', value: `${compareStats.gainHa} ha`, accent: 'text-emerald-700' },
                  {
                    label: 'Net',
                    value: `${compareStats.netChangeHa > 0 ? '+' : ''}${compareStats.netChangeHa} ha`,
                    accent:
                      compareStats.netChangeHa < 0
                        ? 'text-red-700'
                        : compareStats.netChangeHa > 0
                        ? 'text-emerald-700'
                        : 'text-zinc-900',
                  },
                  {
                    label: 'Net %',
                    value: `${compareStats.netChangePct > 0 ? '+' : ''}${compareStats.netChangePct}%`,
                    accent:
                      compareStats.netChangePct < 0
                        ? 'text-red-700'
                        : compareStats.netChangePct > 0
                        ? 'text-emerald-700'
                        : 'text-zinc-900',
                  },
                  { label: 'Trees before', value: `${compareStats.beforeTreeHa} ha` },
                  { label: 'Trees after', value: `${compareStats.afterTreeHa} ha` },
                  { label: 'Scenes before', value: String(compareStats.beforeImageCount) },
                  { label: 'Scenes after', value: String(compareStats.afterImageCount) },
                ].map((s) => (
                  <div key={s.label} className="bg-white px-3 py-2">
                    <div className="text-[10px] uppercase tracking-wider text-zinc-400">
                      {s.label}
                    </div>
                    <div className={`text-sm font-medium mt-0.5 ${s.accent ?? 'text-zinc-900'}`}>
                      {s.value}
                    </div>
                  </div>
                ))}
              </div>

              {/* Raw NDVI comparison — independent of the 0.4 threshold. */}
              <div className="mt-3 text-[10px] uppercase tracking-wider text-zinc-400">
                NDVI (mean over polygon)
              </div>
              <div
                className={`mt-1 grid gap-px bg-zinc-200 border border-zinc-200 rounded-md overflow-hidden ${
                  expanded ? 'grid-cols-3' : 'grid-cols-3'
                }`}
              >
                {(() => {
                  const before = compareStats.beforeNdviMean
                  const after = compareStats.afterNdviMean
                  const delta = compareStats.ndviMeanDelta
                  const fmt = (n: number | null, sign = false) =>
                    n === null
                      ? '—'
                      : `${sign && n > 0 ? '+' : ''}${n.toFixed(3)}`
                  const deltaAccent =
                    delta === null || delta === 0
                      ? 'text-zinc-900'
                      : delta < 0
                      ? 'text-red-700'
                      : 'text-emerald-700'
                  return [
                    { label: 'NDVI before', value: fmt(before), accent: 'text-zinc-900' },
                    { label: 'NDVI after', value: fmt(after), accent: 'text-zinc-900' },
                    { label: 'Δ NDVI', value: fmt(delta, true), accent: deltaAccent },
                  ].map((s) => (
                    <div key={s.label} className="bg-white px-3 py-2">
                      <div className="text-[10px] uppercase tracking-wider text-zinc-400">
                        {s.label}
                      </div>
                      <div className={`text-sm font-medium mt-0.5 ${s.accent}`}>
                        {s.value}
                      </div>
                    </div>
                  ))
                })()}
              </div>

              {(compareStats.beforeNdviMin !== null ||
                compareStats.beforeNdviMax !== null ||
                compareStats.afterNdviMin !== null ||
                compareStats.afterNdviMax !== null) && (
                <p className="mt-2 text-[11px] text-zinc-500">
                  Range before:{' '}
                  {compareStats.beforeNdviMin !== null
                    ? compareStats.beforeNdviMin.toFixed(3)
                    : '—'}{' '}
                  →{' '}
                  {compareStats.beforeNdviMax !== null
                    ? compareStats.beforeNdviMax.toFixed(3)
                    : '—'}
                  . Range after:{' '}
                  {compareStats.afterNdviMin !== null
                    ? compareStats.afterNdviMin.toFixed(3)
                    : '—'}{' '}
                  →{' '}
                  {compareStats.afterNdviMax !== null
                    ? compareStats.afterNdviMax.toFixed(3)
                    : '—'}
                  .
                </p>
              )}
            </>
          )}

          {compareTiles && (
            <>
              <div className="mt-3 space-y-1.5">
                {(
                  [
                    { key: 'change', label: 'Change classes (loss / gain)' },
                    { key: 'delta', label: 'NDVI delta (after − before)' },
                    { key: 'before', label: 'NDVI · before' },
                    { key: 'after', label: 'NDVI · after' },
                  ] as const
                ).map(({ key, label }) => (
                  <label
                    key={key}
                    className="flex items-center gap-2 text-xs text-zinc-700 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={visibleCompareLayers[key]}
                      onChange={(e) =>
                        setVisibleCompareLayers((v) => ({ ...v, [key]: e.target.checked }))
                      }
                      className="accent-zinc-900"
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>

              {visibleCompareLayers.change && (
                <div className="mt-3 border border-zinc-200 rounded-md p-2.5">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-400 mb-1.5">
                    Change classes
                  </div>
                  <ul className="space-y-1">
                    <li className="flex items-center gap-2">
                      <span className="w-4 h-3 border border-zinc-300 shrink-0 bg-[#dc2626]" />
                      <span className="text-[11px] text-zinc-700">Tree loss</span>
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="w-4 h-3 border border-zinc-300 shrink-0 bg-[#16a34a]" />
                      <span className="text-[11px] text-zinc-700">Tree gain</span>
                    </li>
                  </ul>
                </div>
              )}

              {visibleCompareLayers.delta && (
                <div className="mt-3 border border-zinc-200 rounded-md p-2.5">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-400 mb-1.5">
                    NDVI delta
                  </div>
                  <div
                    className="h-3 rounded-sm border border-zinc-300"
                    style={{
                      background:
                        'linear-gradient(to right, #7f1d1d, #ef4444, #ffffff, #22c55e, #14532d)',
                    }}
                  />
                  <div className="flex justify-between mt-1 text-[10px] text-zinc-500">
                    <span>−0.4 (loss)</span>
                    <span>0</span>
                    <span>+0.4 (gain)</span>
                  </div>
                </div>
              )}
            </>
          )}
        </Section>

        <Section label="Time series">
          <div className="space-y-2">
            <div>
              <label className={labelCls}>Dataset</label>
              <select
                value={tsDataset}
                onChange={(e) => setTsDataset(e.target.value as DatasetId)}
                className={inputCls}
              >
                {DATASETS.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelCls}>Start</label>
                <input
                  type="date"
                  value={tsStart}
                  onChange={(e) => setTsStart(e.target.value)}
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>End</label>
                <input
                  type="date"
                  value={tsEnd}
                  onChange={(e) => setTsEnd(e.target.value)}
                  className={inputCls}
                />
              </div>
            </div>
            <button
              onClick={getTimeSeries}
              disabled={tsLoading}
              className={`${btnPrimary} w-full`}
            >
              {tsLoading ? 'Querying…' : 'Get time series'}
            </button>
          </div>

          {tsError && <p className="mt-2 text-xs text-red-600">{tsError}</p>}

          {tsData && tsData.length > 0 && (
            <div className="mt-3">
              <div className="text-[10px] uppercase tracking-wider text-zinc-400 mb-1">
                {DATASETS.find((d) => d.id === tsDataset)?.label} · {tsData.length} points
              </div>
              <div ref={chartContainerRef} className={expanded ? 'h-80' : 'h-48'}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={tsData.filter((p) => p.value !== null)}
                    margin={{ top: 8, right: 8, left: -16, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="2 4" stroke="#e4e4e7" />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 9, fill: '#71717a' }}
                      stroke="#d4d4d8"
                    />
                    <YAxis
                      tick={{ fontSize: 9, fill: '#71717a' }}
                      stroke="#d4d4d8"
                    />
                    <Tooltip
                      contentStyle={{
                        fontSize: 11,
                        background: '#ffffff',
                        border: '1px solid #e4e4e7',
                        borderRadius: 6,
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="value"
                      stroke="#18181b"
                      strokeWidth={1.25}
                      dot={{ r: 1.5, fill: '#18181b' }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {tsData && tsData.length === 0 && (
            <p className="mt-2 text-xs text-zinc-500">No data for this range.</p>
          )}
        </Section>
      </aside>

      {/* ── Map ───────────────────────────────────────────────────────────── */}
      <div className="flex-1 relative">
        <MapContainer
          center={center}
          zoom={zoom}
          maxZoom={22}
          style={{ position: 'absolute', inset: 0, height: '100%', width: '100%' }}
        >
          <SetView center={center} zoom={zoom} />
          <FlyToLocation target={flyTarget} />

          <TileLayer
            attribution="Tiles © Esri"
            url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            maxNativeZoom={19}
            maxZoom={22}
          />

          {/* GEE overlays */}
          {geeTiles?.rgb && visibleLayers.rgb && (
            <TileLayer
              key={`gee-rgb-${geeTiles.rgb}`}
              url={geeTiles.rgb}
              opacity={0.9}
              maxNativeZoom={18}
              maxZoom={22}
            />
          )}
          {geeTiles?.ndvi && visibleLayers.ndvi && (
            <TileLayer
              key={`gee-ndvi-${geeTiles.ndvi}`}
              url={geeTiles.ndvi}
              opacity={0.75}
              maxNativeZoom={18}
              maxZoom={22}
            />
          )}
          {geeTiles?.trees && visibleLayers.trees && (
            <TileLayer
              key={`gee-trees-${geeTiles.trees}`}
              url={geeTiles.trees}
              opacity={0.25}
              maxNativeZoom={18}
              maxZoom={22}
            />
          )}

          {/* Compare-dates overlays */}
          {compareTiles?.before && visibleCompareLayers.before && (
            <TileLayer
              key={`cmp-before-${compareTiles.before}`}
              url={compareTiles.before}
              opacity={0.7}
              maxNativeZoom={18}
              maxZoom={22}
            />
          )}
          {compareTiles?.after && visibleCompareLayers.after && (
            <TileLayer
              key={`cmp-after-${compareTiles.after}`}
              url={compareTiles.after}
              opacity={0.7}
              maxNativeZoom={18}
              maxZoom={22}
            />
          )}
          {compareTiles?.delta && visibleCompareLayers.delta && (
            <TileLayer
              key={`cmp-delta-${compareTiles.delta}`}
              url={compareTiles.delta}
              opacity={0.75}
              maxNativeZoom={18}
              maxZoom={22}
            />
          )}
          {compareTiles?.change && visibleCompareLayers.change && (
            <TileLayer
              key={`cmp-change-${compareTiles.change}`}
              url={compareTiles.change}
              opacity={0.7}
              maxNativeZoom={18}
              maxZoom={22}
            />
          )}

          <ClickToAddPoints drawing={drawing} points={points} setPoints={setPoints} />

          {importedPolygons
            .filter((p) => p.visible)
            .map((poly) => (
              <Polygon
                key={poly.id}
                positions={poly.points.map((p) => [p.lat, p.lng] as [number, number])}
                pathOptions={{
                  color: editingImportedId === poly.id ? '#f59e0b' : '#fde047',
                  fillColor: editingImportedId === poly.id ? '#f59e0b' : '#facc15',
                  fillOpacity: editingImportedId === poly.id ? 0.45 : 0.35,
                  weight: editingImportedId === poly.id ? 3 : 2.5,
                }}
              />
            ))}

          {points.map((point, index) => (
            <Marker
              key={`${point.lat}-${point.lng}-${index}`}
              position={[point.lat, point.lng]}
              icon={pinIcon}
            />
          ))}

          {points.length > 1 && (
            <Polyline
              positions={points.map((p) => [p.lat, p.lng] as [number, number])}
              pathOptions={{ color: '#18181b', weight: 1.5 }}
            />
          )}

          {isFinished && closedPoints.length > 3 && (
            <Polygon
              positions={closedPoints.map((p) => [p.lat, p.lng] as [number, number])}
              pathOptions={{
                color: '#18181b',
                fillColor: '#18181b',
                fillOpacity: 0.15,
                weight: 1.75,
              }}
            />
          )}

          {bounds && (
            <Rectangle
              bounds={[
                [bounds.minLat, bounds.minLng],
                [bounds.maxLat, bounds.maxLng],
              ]}
              pathOptions={{
                color: '#a1a1aa',
                weight: 1,
                dashArray: '4 3',
                fill: false,
              }}
            />
          )}
        </MapContainer>
      </div>
    </div>
  )
}
