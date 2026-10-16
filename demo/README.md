# demo/

The StudyBroker dashboard demo: https://broker.demo.learnscada.com

A web page that shows what the study broker is doing, the way
the StudyBroker dashboard does on a real server, driven by a
**simulated** broker that runs in your browser. Nothing here
connects to a real broker. Reloading the page starts it over.

| File | What it is |
|------|------------|
| `sim.js` | The simulation: sessions, routing, retained messages, wills, QoS 1, keepalive, the Sparkplug tap, the fault knobs, member sign-in, and the lab programs (edge node, host, connection endings, pub/sub client, Sparkplug dump). Trace lines use the format of `broker/trace.py`. |
| `ui.js` | The dashboard's ten screens drawn from the simulation. |
| `index.html`, `app.css` | The page and its styles. |

The demo is not part of the printed book, so it does not follow
the 64-character line limit of the listings. The programs it
imitates are the real ones in `broker/`, `tap/`, `edge/`,
`host/` and `labs/`.

## Where each chapter shows up

| Screen | Book |
|--------|------|
| Trace | Chapters 2, 3, Appendix A |
| Clients (kick a client, watch its will) | Chapters 4, 6, 7, 8 |
| Topics (test a filter, retained messages) | Chapters 5, 6 |
| Sparkplug and the tap events | Chapters 9 to 11, 14, 15, 18 |
| Faults, Labs (the Chapter 19 presets) | Chapters 17, 19 |
| Diagnostics (traffic colored by kind) | Chapters 3, 7, 16 |
| Notebook (predict, then run) | Chapter 19 |

## Run it on your own machine

No build step. From the repository folder:

```
cd demo
python -m http.server 8812
```

Then open http://127.0.0.1:8812.

## Publish a change

The live demo is the Cloudflare Pages project
`studybroker-mockup`, served at broker.demo.learnscada.com.
Bump the `?v=` numbers in `index.html` so returning visitors get
the new files, then:

```
npx wrangler pages deploy demo --project-name studybroker-mockup --branch main
```
