#let title = "Untitled Brief"

#set document(title: title)
#set page(margin: (x: 0.85in, y: 0.8in))
#set text(size: 10.5pt)
#set par(justify: true, leading: 0.58em)

#align(center)[
  #text(size: 22pt, weight: "bold")[#title]
  #linebreak()
  #text(size: 11pt, fill: luma(40%))[Draft brief]
]

#v(1em)

#block(fill: luma(96%), inset: 12pt, radius: 4pt)[
  #text(weight: "bold")[Summary]
  #linebreak()
  Draft the core point here. Edit this file directly and add charts or images under #raw("assets/").
]

== Context

Describe the situation, audience, and constraints.

== Recommendation

State the recommended path and why it is the best tradeoff.
