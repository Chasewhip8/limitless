// Sphere theme tokens. Import ../sphere.typ for the public API.

#let sphere-font = "Inter"

#let sphere = (
  colors: (
    navy: rgb("#0E2B3D"),
    blue: rgb("#0661F2"),
    soft-blue: rgb("#DBEAFF"),
    pale-bg: rgb("#F6FAFE"),
    slate: rgb("#73879E"),
    border: rgb("#D8E4EF"),
    hairline: rgb("#E8F0F7"),
  ),
  frame: (
    stroke: rgb("#D8E4EF"),
    dash: true,
    corner-mark: true,
  ),
  radius: (
    card: 6pt,
    pill: 999pt,
  ),
  spacing: (
    gap: 10pt,
    page-x: 0.72in,
    page-top: 0.74in,
    page-bottom: 0.66in,
  ),
)

#let navy = sphere.colors.navy
#let slate = sphere.colors.slate
#let muted = slate
#let quiet = rgb("#B9C7D6")
#let line = sphere.colors.border
#let hairline = sphere.colors.hairline
#let pale = sphere.colors.pale-bg
#let white-blue = rgb("#FBFDFF")
#let soft-blue-2 = rgb("#EAF3FF")
#let blue = sphere.colors.blue
#let blue-700 = rgb("#1552C8")
#let blue-500 = rgb("#2970FF")
#let blue-300 = rgb("#8FB9FF")
#let blue-100 = rgb("#EFF6FF")
#let warning = rgb("#B7791F")
#let warning-bg = rgb("#FFF7E6")
#let success = rgb("#178A5E")
#let success-bg = rgb("#EAF8F2")

#let sphere-page-size = (width: 8.5in, height: 11in)
#let sphere-page-margin = (left: 0.72in, right: 0.72in, top: 0.74in, bottom: 0.66in)
#let sphere-content-inset = sphere-page-margin
#let sphere-frame-inset = 0.29in
#let sphere-card-inset = (x: 10pt, y: 8pt)

#let sphere-doc-defaults = (
  title: none,
  date: none,
  confidentiality: "[ Private & Confidential ]",
  frame: true,
  corner_marks: true,
  frame_inset: sphere-frame-inset,
  content_inset: sphere-content-inset,
)

#let sphere-doc-config = state("sphere-document-config", sphere-doc-defaults)

#let sphere-resolve(value, fallback) = if value == auto { fallback } else { value }
