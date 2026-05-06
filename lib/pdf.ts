import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'

// ─── Types: shape of the data the report needs ────────────────────────────────

export type PdfPolygon = {
  title: string
  /** [lng, lat] pairs (closed ring). */
  coords: [number, number][]
}

export type PdfAnalysis = {
  date: string
  cloudPct: number
  treeThreshold: number
  windowDays: number
  /** EE thumbnail URL of the NDVI raster clipped to the polygon. */
  ndviThumbUrl?: string
  stats: {
    polygonAreaHa: number
    treeAreaHa: number
    treeCoveragePct: number
    imageCount: number
  }
}

export type PdfCompare = {
  dateBefore: string
  dateAfter: string
  windowDays: number
  cloudPct: number
  treeThreshold: number
  /** EE thumbnail URL of the (after − before) NDVI delta clipped to the polygon. */
  deltaThumbUrl?: string
  stats: {
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
}

export type PdfTimeSeries = {
  datasetLabel: string
  unit: string
  startDate: string
  endDate: string
  series: { date: string; value: number | null }[]
  /** Pre-rendered PNG data URL of the recharts chart, if any. */
  chartImage?: string
}

export type PdfReportData = {
  polygon: PdfPolygon | null
  analysis?: PdfAnalysis
  compare?: PdfCompare
  timeSeries?: PdfTimeSeries
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const PAGE_W = 595.28 // A4 portrait pt
const PAGE_H = 841.89
const MARGIN = 40

function fmt(d = new Date()) {
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
}

function num(n: number, digits = 2) {
  return Number.isFinite(n) ? n.toFixed(digits) : '—'
}

/**
 * Render a recharts <svg> inside `containerEl` to a PNG data URL.
 * Returns null if no SVG present or the conversion fails.
 *
 * Works fully in-browser, no server round-trip, no extra deps —
 * uses the standard SVG → Image → Canvas → toDataURL pipeline.
 */
export async function svgToPng(
  containerEl: HTMLElement | null,
  scale = 2
): Promise<string | null> {
  if (!containerEl) return null
  const svg = containerEl.querySelector('svg')
  if (!svg) return null

  // Inline computed styles aren't strictly required for recharts (it draws with
  // explicit attrs), but we serialize a clone to keep the DOM untouched.
  const clone = svg.cloneNode(true) as SVGSVGElement
  const w = svg.clientWidth || 600
  const h = svg.clientHeight || 240
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('width', String(w))
  clone.setAttribute('height', String(h))

  const xml = new XMLSerializer().serializeToString(clone)
  const svgUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml)

  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = w * scale
      canvas.height = h * scale
      const ctx = canvas.getContext('2d')
      if (!ctx) return resolve(null)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.scale(scale, scale)
      ctx.drawImage(img, 0, 0)
      try {
        resolve(canvas.toDataURL('image/png'))
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = svgUrl
  })
}

// ─── Image loading + legend drawing helpers ───────────────────────────────────

type LoadedImage = { dataUrl: string; width: number; height: number }

/** Fetches a URL, converts to data URL, and reports natural dimensions. */
async function loadImageAsDataUrl(url: string): Promise<LoadedImage | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const blob = await res.blob()
    const dataUrl: string = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
    const dims: { width: number; height: number } = await new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve({ width: img.width, height: img.height })
      img.onerror = reject
      img.src = dataUrl
    })
    return { dataUrl, ...dims }
  } catch {
    return null
  }
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}

const PDF_NDVI_KEY: { hex: string; label: string }[] = [
  { hex: 'FFFFFF', label: '0.00 — none' },
  { hex: 'CE7E45', label: '0.05' },
  { hex: 'DF923D', label: '0.10' },
  { hex: 'F1B555', label: '0.15' },
  { hex: 'FCD163', label: '0.20' },
  { hex: '99B718', label: '0.25' },
  { hex: '74A901', label: '0.30' },
  { hex: '66A000', label: '0.35' },
  { hex: '529400', label: '0.40 — moderate' },
  { hex: '3E8601', label: '0.45' },
  { hex: '207401', label: '0.50' },
  { hex: '056201', label: '0.60' },
  { hex: '004C00', label: '0.70+ — dense' },
]

const PDF_DELTA_PALETTE = [
  '7f1d1d', 'b91c1c', 'ef4444', 'fca5a5', 'ffffff',
  '86efac', '22c55e', '15803d', '14532d',
]

/** Draws the NDVI palette key as a vertical column starting at (x, y). Returns y after. */
function drawNdviKey(doc: jsPDF, x: number, y: number): number {
  doc.setFont('helvetica', 'bold').setFontSize(7).setTextColor('#71717a')
  doc.text('NDVI', x, y)
  y += 5
  for (const row of PDF_NDVI_KEY) {
    const [r, g, b] = hexToRgb(row.hex)
    doc.setFillColor(r, g, b)
    doc.setDrawColor('#d4d4d8')
    doc.setLineWidth(0.3)
    doc.rect(x, y, 8, 5.5, 'FD')
    doc.setFont('helvetica', 'normal').setFontSize(6.5).setTextColor('#27272a')
    doc.text(row.label, x + 11, y + 4.2)
    y += 7
  }
  return y
}

/** Draws the diverging-delta gradient strip + −/0/+ labels. Returns y after. */
function drawDeltaKey(doc: jsPDF, x: number, y: number, w: number): number {
  doc.setFont('helvetica', 'bold').setFontSize(7).setTextColor('#71717a')
  doc.text('NDVI Δ (after − before)', x, y)
  y += 5
  const stepW = w / PDF_DELTA_PALETTE.length
  PDF_DELTA_PALETTE.forEach((c, i) => {
    const [r, g, b] = hexToRgb(c)
    doc.setFillColor(r, g, b)
    doc.rect(x + i * stepW, y, stepW, 6, 'F')
  })
  doc.setDrawColor('#d4d4d8')
  doc.setLineWidth(0.3)
  doc.rect(x, y, w, 6, 'D')
  y += 11
  doc.setFont('helvetica', 'normal').setFontSize(6.5).setTextColor('#71717a')
  doc.text('-0.4 (loss)', x, y)
  doc.text('0', x + w / 2, y, { align: 'center' })
  doc.text('+0.4 (gain)', x + w, y, { align: 'right' })
  return y + 4
}

// Image column geometry — used by both analyze and compare sections.
const IMG_COL_W = 180
const GUTTER = 16

// ─── Main entry ───────────────────────────────────────────────────────────────

export async function generatePdfReport(data: PdfReportData): Promise<jsPDF> {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' })

  // ── Header ──
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.setTextColor('#18181b')
  doc.text('Tropenbos Ghana Monitoring Dashboard', MARGIN, MARGIN + 6)

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor('#71717a')
  doc.text(`Generated ${fmt()}`, MARGIN, MARGIN + 22)

  doc.setDrawColor('#e4e4e7')
  doc.setLineWidth(0.5)
  doc.line(MARGIN, MARGIN + 32, PAGE_W - MARGIN, MARGIN + 32)

  let cursorY = MARGIN + 52

  // ── Polygon ──
  if (data.polygon) {
    cursorY = sectionHeading(doc, 'Region of interest', cursorY)
    autoTable(doc, {
      startY: cursorY,
      theme: 'plain',
      styles: { fontSize: 10, cellPadding: 4, textColor: '#18181b' },
      head: [['Field', 'Value']],
      headStyles: {
        fillColor: '#fafafa',
        textColor: '#71717a',
        fontStyle: 'normal',
        fontSize: 8,
        halign: 'left',
      },
      columnStyles: { 0: { cellWidth: 120, textColor: '#71717a' } },
      body: [
        ['Polygon', data.polygon.title],
        ['Vertices', String(data.polygon.coords.length - 1)],
        [
          'Centroid',
          (() => {
            const [cx, cy] = centroidLngLat(data.polygon.coords)
            return `${cy.toFixed(4)}°, ${cx.toFixed(4)}°`
          })(),
        ],
      ],
      margin: { left: MARGIN, right: MARGIN },
    })
    cursorY = (doc as unknown as { lastAutoTable: { finalY: number } })
      .lastAutoTable.finalY + 18
  }

  // ── Single-date analysis ──
  if (data.analysis) {
    cursorY = sectionHeading(doc, 'NDVI analysis', cursorY)
    const a = data.analysis

    // Pre-fetch the NDVI thumbnail so we can lay out around it.
    const ndviImg = a.ndviThumbUrl ? await loadImageAsDataUrl(a.ndviThumbUrl) : null

    const sectionTop = cursorY
    const imgX = PAGE_W - MARGIN - IMG_COL_W
    const rightMargin = ndviImg ? IMG_COL_W + GUTTER + MARGIN : MARGIN

    let imageBottom = sectionTop
    if (ndviImg) {
      const aspect = ndviImg.height / ndviImg.width
      const renderW = Math.min(IMG_COL_W, ndviImg.width)
      const renderH = renderW * aspect
      doc.addImage(ndviImg.dataUrl, 'PNG', imgX, sectionTop, renderW, renderH)
      doc.setDrawColor('#e4e4e7')
      doc.setLineWidth(0.3)
      doc.rect(imgX, sectionTop, renderW, renderH)
      imageBottom = sectionTop + renderH + 6
      imageBottom = drawNdviKey(doc, imgX, imageBottom)
    }

    autoTable(doc, {
      startY: cursorY,
      theme: 'plain',
      styles: { fontSize: 10, cellPadding: 4, textColor: '#18181b' },
      headStyles: {
        fillColor: '#fafafa',
        textColor: '#71717a',
        fontStyle: 'normal',
        fontSize: 8,
        halign: 'left',
      },
      columnStyles: { 0: { cellWidth: 110, textColor: '#71717a' } },
      head: [['Parameter', 'Value']],
      body: [
        ['Date', a.date],
        ['Window', `± ${a.windowDays} days`],
        ['Cloud filter', `< ${a.cloudPct}% (scene-level)`],
        ['Tree threshold', `NDVI > ${a.treeThreshold}`],
      ],
      margin: { left: MARGIN, right: rightMargin },
    })
    cursorY = (doc as unknown as { lastAutoTable: { finalY: number } })
      .lastAutoTable.finalY + 8

    autoTable(doc, {
      startY: cursorY,
      theme: 'striped',
      styles: { fontSize: 10, cellPadding: 6, textColor: '#18181b' },
      headStyles: {
        fillColor: '#fafafa',
        textColor: '#71717a',
        fontStyle: 'normal',
        fontSize: 8,
      },
      head: [['Polygon area', 'Tree area', 'Coverage', 'Scenes']],
      body: [
        [
          `${num(a.stats.polygonAreaHa)} ha`,
          `${num(a.stats.treeAreaHa)} ha`,
          `${num(a.stats.treeCoveragePct)}%`,
          String(a.stats.imageCount),
        ],
      ],
      margin: { left: MARGIN, right: rightMargin },
    })
    const tableBottom = (doc as unknown as { lastAutoTable: { finalY: number } })
      .lastAutoTable.finalY
    cursorY = Math.max(tableBottom, imageBottom) + 18
  }

  // ── Compare dates ──
  if (data.compare) {
    cursorY = ensureSpace(doc, cursorY, 260)
    cursorY = sectionHeading(doc, 'Compare dates', cursorY)
    const c = data.compare

    // Pre-fetch the delta thumbnail.
    const deltaImg = c.deltaThumbUrl ? await loadImageAsDataUrl(c.deltaThumbUrl) : null

    const sectionTop = cursorY
    const imgX = PAGE_W - MARGIN - IMG_COL_W
    const rightMargin = deltaImg ? IMG_COL_W + GUTTER + MARGIN : MARGIN

    let imageBottom = sectionTop
    if (deltaImg) {
      const aspect = deltaImg.height / deltaImg.width
      const renderW = Math.min(IMG_COL_W, deltaImg.width)
      const renderH = renderW * aspect
      doc.addImage(deltaImg.dataUrl, 'PNG', imgX, sectionTop, renderW, renderH)
      doc.setDrawColor('#e4e4e7')
      doc.setLineWidth(0.3)
      doc.rect(imgX, sectionTop, renderW, renderH)
      imageBottom = sectionTop + renderH + 6
      imageBottom = drawDeltaKey(doc, imgX, imageBottom, IMG_COL_W)
    }

    autoTable(doc, {
      startY: cursorY,
      theme: 'plain',
      styles: { fontSize: 10, cellPadding: 4, textColor: '#18181b' },
      headStyles: {
        fillColor: '#fafafa',
        textColor: '#71717a',
        fontStyle: 'normal',
        fontSize: 8,
        halign: 'left',
      },
      columnStyles: { 0: { cellWidth: 110, textColor: '#71717a' } },
      head: [['Parameter', 'Value']],
      body: [
        ['Before', c.dateBefore],
        ['After', c.dateAfter],
        ['Window', `± ${c.windowDays} days each`],
        ['Cloud filter', `< ${c.cloudPct}%`],
        ['Tree threshold', `NDVI > ${c.treeThreshold}`],
      ],
      margin: { left: MARGIN, right: rightMargin },
    })
    cursorY = (doc as unknown as { lastAutoTable: { finalY: number } })
      .lastAutoTable.finalY + 8

    autoTable(doc, {
      startY: cursorY,
      theme: 'striped',
      styles: { fontSize: 9.5, cellPadding: 5, textColor: '#18181b' },
      headStyles: {
        fillColor: '#fafafa',
        textColor: '#71717a',
        fontStyle: 'normal',
        fontSize: 8,
      },
      head: [['Loss', 'Gain', 'Net change', 'Net %']],
      body: [
        [
          `${num(c.stats.lossHa)} ha`,
          `${num(c.stats.gainHa)} ha`,
          `${c.stats.netChangeHa > 0 ? '+' : ''}${num(c.stats.netChangeHa)} ha`,
          `${c.stats.netChangePct > 0 ? '+' : ''}${num(c.stats.netChangePct)}%`,
        ],
      ],
      didParseCell: (cellData) => {
        // Color the loss / gain / net cells based on direction.
        if (cellData.section === 'body') {
          const v = cellData.cell.text.join(' ')
          if (cellData.column.index === 0 && parseFloat(v) > 0) {
            cellData.cell.styles.textColor = '#b91c1c'
          } else if (cellData.column.index === 1 && parseFloat(v) > 0) {
            cellData.cell.styles.textColor = '#15803d'
          } else if (
            (cellData.column.index === 2 || cellData.column.index === 3) &&
            v.startsWith('-')
          ) {
            cellData.cell.styles.textColor = '#b91c1c'
          } else if (
            (cellData.column.index === 2 || cellData.column.index === 3) &&
            v.startsWith('+')
          ) {
            cellData.cell.styles.textColor = '#15803d'
          }
        }
      },
      margin: { left: MARGIN, right: rightMargin },
    })
    cursorY = (doc as unknown as { lastAutoTable: { finalY: number } })
      .lastAutoTable.finalY + 8

    autoTable(doc, {
      startY: cursorY,
      theme: 'plain',
      styles: { fontSize: 9.5, cellPadding: 4, textColor: '#18181b' },
      headStyles: {
        fillColor: '#fafafa',
        textColor: '#71717a',
        fontStyle: 'normal',
        fontSize: 8,
        halign: 'left',
      },
      columnStyles: { 0: { cellWidth: 140, textColor: '#71717a' } },
      head: [['Reference', 'Value']],
      body: [
        ['Tree cover before', `${num(c.stats.beforeTreeHa)} ha`],
        ['Tree cover after', `${num(c.stats.afterTreeHa)} ha`],
        ['Polygon area', `${num(c.stats.polygonAreaHa)} ha`],
        [
          'Scenes (before / after)',
          `${c.stats.beforeImageCount} / ${c.stats.afterImageCount}`,
        ],
      ],
      margin: { left: MARGIN, right: rightMargin },
    })
    cursorY = (doc as unknown as { lastAutoTable: { finalY: number } })
      .lastAutoTable.finalY + 8

    // ── Raw NDVI comparison (independent of tree threshold) ──
    autoTable(doc, {
      startY: cursorY,
      theme: 'striped',
      styles: { fontSize: 9.5, cellPadding: 5, textColor: '#18181b' },
      headStyles: {
        fillColor: '#fafafa',
        textColor: '#71717a',
        fontStyle: 'normal',
        fontSize: 8,
      },
      head: [['NDVI before', 'NDVI after', 'Δ NDVI']],
      body: [
        [
          c.stats.beforeNdviMean !== null
            ? c.stats.beforeNdviMean.toFixed(3)
            : '—',
          c.stats.afterNdviMean !== null
            ? c.stats.afterNdviMean.toFixed(3)
            : '—',
          c.stats.ndviMeanDelta !== null
            ? `${c.stats.ndviMeanDelta > 0 ? '+' : ''}${c.stats.ndviMeanDelta.toFixed(3)}`
            : '—',
        ],
      ],
      didParseCell: (cellData) => {
        if (cellData.section === 'body' && cellData.column.index === 2) {
          const v = cellData.cell.text.join(' ')
          if (v.startsWith('-')) cellData.cell.styles.textColor = '#b91c1c'
          else if (v.startsWith('+')) cellData.cell.styles.textColor = '#15803d'
        }
      },
      margin: { left: MARGIN, right: rightMargin },
    })
    cursorY = (doc as unknown as { lastAutoTable: { finalY: number } })
      .lastAutoTable.finalY + 4

    // NDVI ranges as a small caption-style line (constrained to the left column).
    if (
      c.stats.beforeNdviMin !== null ||
      c.stats.beforeNdviMax !== null ||
      c.stats.afterNdviMin !== null ||
      c.stats.afterNdviMax !== null
    ) {
      doc.setFont('helvetica', 'normal')
      doc.setFontSize(7.5)
      doc.setTextColor('#71717a')
      const fmt3 = (n: number | null) => (n !== null ? n.toFixed(3) : '—')
      const leftWidth =
        PAGE_W - MARGIN - rightMargin
      const txt = `NDVI range — before: ${fmt3(c.stats.beforeNdviMin)} → ${fmt3(c.stats.beforeNdviMax)}. After: ${fmt3(c.stats.afterNdviMin)} → ${fmt3(c.stats.afterNdviMax)}.`
      const wrapped = doc.splitTextToSize(txt, leftWidth)
      doc.text(wrapped, MARGIN, cursorY + 10)
      cursorY += 10 + wrapped.length * 9
    }

    // Make sure we clear the image too.
    cursorY = Math.max(cursorY, imageBottom) + 12
  }

  // ── Time series ──
  if (data.timeSeries) {
    cursorY = ensureSpace(doc, cursorY, 280)
    cursorY = sectionHeading(doc, 'Time series', cursorY)
    const t = data.timeSeries
    autoTable(doc, {
      startY: cursorY,
      theme: 'plain',
      styles: { fontSize: 10, cellPadding: 4, textColor: '#18181b' },
      headStyles: {
        fillColor: '#fafafa',
        textColor: '#71717a',
        fontStyle: 'normal',
        fontSize: 8,
        halign: 'left',
      },
      columnStyles: { 0: { cellWidth: 120, textColor: '#71717a' } },
      head: [['Field', 'Value']],
      body: [
        ['Dataset', t.datasetLabel],
        ['Unit', t.unit],
        ['Range', `${t.startDate} → ${t.endDate}`],
        ['Points', String(t.series.filter((p) => p.value != null).length)],
      ],
      margin: { left: MARGIN, right: MARGIN },
    })
    cursorY = (doc as unknown as { lastAutoTable: { finalY: number } })
      .lastAutoTable.finalY + 10

    if (t.chartImage) {
      const imgW = PAGE_W - MARGIN * 2
      const imgH = imgW * 0.4
      cursorY = ensureSpace(doc, cursorY, imgH + 12)
      doc.addImage(t.chartImage, 'PNG', MARGIN, cursorY, imgW, imgH)
      cursorY += imgH + 12
    }
  }

  // ── Footer (page numbers) ──
  const pageCount = doc.getNumberOfPages()
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i)
    doc.setFont('helvetica', 'normal')
    doc.setFontSize(8)
    doc.setTextColor('#a1a1aa')
    doc.text(
      `Tropenbos Ghana · ${fmt(new Date())} · page ${i} of ${pageCount}`,
      PAGE_W / 2,
      PAGE_H - 18,
      { align: 'center' }
    )
  }

  return doc
}

// ─── Internals ────────────────────────────────────────────────────────────────

function sectionHeading(doc: jsPDF, label: string, y: number) {
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(11)
  doc.setTextColor('#18181b')
  doc.text(label, MARGIN, y)
  return y + 8
}

function ensureSpace(doc: jsPDF, y: number, needed: number) {
  if (y + needed > PAGE_H - MARGIN) {
    doc.addPage()
    return MARGIN
  }
  return y
}

function centroidLngLat(coords: [number, number][]): [number, number] {
  let cx = 0
  let cy = 0
  // Drop the closing point if it duplicates the first.
  const ring =
    coords.length > 1 &&
    coords[0][0] === coords[coords.length - 1][0] &&
    coords[0][1] === coords[coords.length - 1][1]
      ? coords.slice(0, -1)
      : coords
  for (const [x, y] of ring) {
    cx += x
    cy += y
  }
  return [cx / ring.length, cy / ring.length]
}
