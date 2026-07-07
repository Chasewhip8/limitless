// Sphere roadmap primitives. Import ../sphere.typ for the public API.
#import "theme.typ": *
#import "chrome.typ": *
#import "layout.typ": *
#import "cards.typ": *
#import "evidence.typ": *

#let sphere-phase(
  number,
  title,
  subtitle: none,
  bullets: (),
  body: none,
  date: none,
  status: none,
) = (
  icon: str(number),
  number: number,
  title: title,
  subtitle: subtitle,
  bullets: bullets,
  body: body,
  date: date,
  status: status,
)

#let sphere-roadmap-phase(phase, icons: true, height: auto) = {
  let subtitle = if phase.at("subtitle", default: none) != none {
    phase.at("subtitle")
  } else {
    phase.at("date", default: none)
  }
  let status = phase.at("status", default: none)
  let bullets = phase.at("bullets", default: ())
  let body = phase.at("body", default: none)
  // Authored roadmaps often start as bullets and collapse into prose; resolve both here.
  let details = if bullets.len() > 0 {
    bullets.map(bullet => text(size: 6.8pt, fill: muted)[• #bullet]).join(linebreak())
  } else if body != none {
    sphere-small(body, fill: muted)
  } else {
    none
  }

  block(width: 100%, height: height)[
    #if icons [
      #sphere-icon(
        phase.at("icon", default: str(phase.at("number", default: ""))),
        fill: blue,
        color: white,
      )
      #v(0.35em)
    ]
    #box(width: 100%, height: 0.8pt, fill: blue-300)
    #v(0.5em)
    #text(size: 9pt, weight: "bold", fill: navy)[#phase.at("title")]
    #if status != none [#h(4pt)#sphere-status-pill(status)]
    #if subtitle != none [
      #linebreak()
      #text(size: 7.2pt, fill: muted)[#subtitle]
    ]
    #v(0.45em)
    #details
  ]
}

#let sphere-roadmap(phases, orientation: "horizontal", icons: true, gap: 10pt, source: none) = [
  #sphere-register-claim("roadmap", "Roadmap", source: source)
  #if orientation == "vertical" [
    #sphere-section-stack(gap: 8pt, ..phases.map(phase => sphere-roadmap-phase(phase, icons: icons)))
  ] else [
    #sphere-grid(
      columns: phases.len(),
      gap: gap,
      ..phases.map(phase => sphere-roadmap-phase(phase, icons: icons)),
    )
  ]
  #if source != none [#v(0.4em)#sphere-source-tag(source)]
]
