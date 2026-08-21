# 😺NKD Reference

Captures whatever is connected as the workflow's active reference, so the other nodes
have something to compare against.

- **NKD Popup Preview** can press-and-hold to flash a reference image over the current
  preview, or lay a reference mask over it, tinted and adjustable.
- **NKD Video Viewer** wipes between its own render and a reference video.
- It takes an IMAGE, a MASK or a VIDEO on the same input.
- Image, mask and video are separate slots, so wire several Reference nodes to have one
  of each. Within a slot, the last node to execute wins.

---

[← All 😺NKD Preview Tools nodes](../README.md)
