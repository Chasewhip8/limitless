// Sphere portrait layout primitives. Import ../sphere.typ for the public API.
//
// The core promise: cards placed next to each other come out the same height.
// `sphere-grid` measures every cell at its final column width, takes the max
// height per row, and rebuilds block cells (cards, charts, callouts) with that
// explicit height so borders and fills stretch to match.
#import "theme.typ": *

#let sphere-grid-columns(columns) = {
  if type(columns) == int {
    (1fr,) * columns
  } else if type(columns) == array {
    columns
  } else {
    (columns,)
  }
}

// Resolve one column spec to an absolute width inside `available` space.
// Fractions share the space left over after fixed and relative columns.
#let sphere--column-widths(columns, available, gap) = {
  let specs = sphere-grid-columns(columns)
  let content = available - gap * (specs.len() - 1)
  let fixed = 0pt
  let fraction-total = 0
  for spec in specs {
    if type(spec) == fraction {
      fraction-total += spec / 1fr
    } else if type(spec) == length {
      fixed += spec
    } else if type(spec) == ratio {
      fixed += content * spec
    } else if type(spec) == relative {
      fixed += content * spec.ratio + spec.length
    }
  }
  let leftover = content - fixed
  specs.map(spec => {
    if type(spec) == fraction {
      if fraction-total == 0 { 0pt } else { leftover * ((spec / 1fr) / fraction-total) }
    } else if type(spec) == length {
      spec
    } else if type(spec) == ratio {
      content * spec
    } else {
      content * spec.ratio + spec.length
    }
  })
}

// Rebuild a block with an explicit height, preserving every styling field.
#let sphere--block-with-height(item, height) = {
  let fields = item.fields()
  let body = fields.remove("body", default: none)
  fields.insert("height", height)
  block(..fields, body)
}

#let sphere--is-block(item) = type(item) == content and item.func() == block
#let sphere--is-sequence(item) = type(item) == content and item.func() == [].func()

// Content that occupies no visual space on its own and can sit next to a
// stretched block without changing what the author meant.
#let sphere--inert-funcs = ([ ].func(), metadata, parbreak)
#let sphere--is-inert(item) = item.func() in sphere--inert-funcs

// Stretch a cell to the row height. Blocks (cards, charts, panels) get a real
// height so chrome stretches; a markup-wrapped block (`[#sphere-card(..)[…]]`)
// is rebuilt in place when the block is the only meaningful child; any other
// content is top-aligned inside an invisible full-height block.
#let sphere--stretch-cell(item, height) = {
  if sphere--is-block(item) {
    sphere--block-with-height(item, height)
  } else if sphere--is-sequence(item) and item.children.filter(child => not sphere--is-inert(child)).len() == 1 and item.children.any(child => sphere--is-block(child)) {
    item.children.map(child => {
      if sphere--is-block(child) { sphere--block-with-height(child, height) } else { child }
    }).join()
  } else {
    block(width: 100%, height: height, item)
  }
}

// Equal-height grid: the workhorse for placing cards side by side.
// `columns` may be a count or an array of track sizes (fr, %, lengths).
// Set `equal: false` for free-flowing text columns.
#let sphere-grid(columns: 2, gap: sphere.spacing.gap, row-gap: none, equal: true, ..children) = {
  let cells = children.pos()
  let specs = sphere-grid-columns(columns)
  let resolved-row-gap = if row-gap == none { gap } else { row-gap }

  if not equal {
    grid(columns: specs, column-gutter: gap, row-gutter: resolved-row-gap, ..cells)
  } else {
    layout(size => {
      let widths = sphere--column-widths(specs, size.width, gap)
      let rows = cells.chunks(specs.len())
      let stretched = rows
        .map(row => {
          let row-height = calc.max(..row
            .enumerate()
            .map(((index, cell)) => measure(box(width: widths.at(index), cell)).height))
          row.map(cell => sphere--stretch-cell(cell, row-height))
        })
        .flatten()
      grid(columns: specs, column-gutter: gap, row-gutter: resolved-row-gap, ..stretched)
    })
  }
}

#let sphere-two-column(
  left-body,
  right-body,
  left: 56%,
  right: 44%,
  gap: 14pt,
  equal: true,
) = sphere-grid(columns: (left, right), gap: gap, equal: equal, left-body, right-body)

#let sphere-hero-split(narrative, visual, visual-side: "right", gap: 16pt) = {
  if visual-side == "left" {
    sphere-two-column(visual, narrative, left: 44%, right: 56%, gap: gap)
  } else {
    sphere-two-column(narrative, visual, left: 56%, right: 44%, gap: gap)
  }
}

#let sphere-section-stack(gap: 8pt, ..children) = grid(
  columns: (1fr,),
  gutter: gap,
  ..children.pos(),
)

// Inline flow of pills/badges that wraps naturally instead of stretching
// items across grid tracks.
#let sphere-inline-flow(items, gap: 5pt, leading: 5pt) = {
  set par(leading: leading, spacing: leading)
  items.join(h(gap))
}

#let sphere-bottom-band(title: none, source: none, tone: "note", body) = block(
  width: 100%,
  fill: if tone == "source" { white-blue } else { pale },
  stroke: 0.45pt + line,
  radius: sphere.radius.card,
  inset: sphere-card-inset,
)[
  #if title != none [
    #text(size: 9.2pt, weight: "bold", fill: navy)[#title]
    #v(0.34em)
  ]
  #body
  #if source != none [
    #v(0.48em)
    #text(size: 6.4pt, fill: muted)[Source: #source]
  ]
]
