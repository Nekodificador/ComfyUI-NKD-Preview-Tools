# 😺NKD Freeze Frames

Holds individual frames of a batch as still images, one per socket.

```mermaid
flowchart LR
    TL["**NKD Timeline**"]:::nkd -- images --> FF
    TL -- markers --> FF
    FF["**NKD Freeze Frames**"]:::nkd --> O1(["images"]):::output
    FF --> O2(["count"]):::output
    FF --> O3(["frame_1, frame_2, …"]):::output

    classDef nkd fill:#3b3b6b,stroke:#8ab4ff,stroke-width:2px,color:#fff
    classDef output fill:#1f4a1f,stroke:#7fd97f,color:#fff
```

- Wire Timeline's `markers` output into `frames` and every frame you marked with **M**
  comes out of its own `frame_N` socket, previewed on the node so you can see which is
  which.
- The `frames` field can just be typed instead: `0, 12, 47`. Any separator works,
  negatives count from the end, and repeats are kept.
- `images` carries the same frames as one batch, and `count` how many there are.

---

[← All 😺NKD Preview Tools nodes](../README.md)
