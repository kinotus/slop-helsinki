# Slop Helsinki

A simulation of central Helsinki built with [three.js](https://threejs.org/), WebGPURenderer, and TSL. Start at Senaatintori and explore the Cathedral, Esplanadi, Kauppatori, Uspenski and the Central Station on foot, by taxi, by bicycle or cargo bike, or by helicopter, among HSL buses and trams.

Based on [Slop Utrecht](https://github.com/bertt/slop-utrecht) by bertt, itself a remix of [Slop New York](https://github.com/mrdoob/slop-newyork) by mrdoob.

## What's Helsinki about it

- Streets, blocks, parks, water, tram lines, stops and landmarks of Kluuvi, Kaartinkaupunki, Kruununhaka, Katajanokka, Kamppi, Punavuori, Ullanlinna, Töölö and Kallio from OpenStreetMap, in a metric frame centred on Senaatintori (x east, z south).
- The City of Helsinki's photo-textured 3D city model (LoD2 buildings, 3D Tiles from [kartta.hel.fi/3d](https://kartta.hel.fi/3d/)), streamed around the camera.
- The real ground: the city's terrain model (N2000 heights) baked into a 2 m height grid. Streets, pavements, parks, props and traffic are draped onto it, and the sea sits at 0 m.
- Street and park trees from OpenStreetMap (`natural=tree`).
- Bilingual street-name signs (Finnish / Swedish), Finnish road markings and number plates, dark Helsinki taxis, blue-light police cars, HSL buses and green-and-white HSL trams running the real routes.
- Low northern sun angles for 60° N.

Buildings and terrain come from the City of Helsinki's open 3D data. Everything else comes from OpenStreetMap. The OSM buildings are still used for collisions and the minimap, and as a fallback when the 3D model can't be loaded.

### URL options

- `?buildings=osm`: generated buildings from OSM footprints and levels, instead of the 3D city model.
- `?terrain=flat`: the old flat city at street level. This also switches to the OSM buildings, because the 3D model needs the real ground.

## Rebuilding the data

```sh
# 1. OpenStreetMap extract (bash; needs curl and node)
tools/overpass.sh tools/data/osm_helsinki.json tools/data/q_helsinki.overpassql
# 2. Generated runtime data
node tools/build-helsinki-geodata.mjs   # -> js/helsinki-geodata.js
node tools/build-helsinki-shops.mjs     # -> js/helsinki-shops.js
# 3. Terrain height grid from the city's Cesium terrain (tiles are cached in tools/data/terrain-cache/)
node tools/build-helsinki-terrain.mjs   # -> assets/helsinki-terrain.bin
```

The 3D city model isn't baked. It streams at runtime from `kartta.hel.fi` (see `HELSINKI_TILESET_URL` in `js/helsinki-tiles.js`).

Serve the repository root with any static file server (for example `npx http-server`) and open `index.html` in a WebGPU-capable browser. To run the tests, run `node --test` on the files in `tests/`.

The logo is loaded from `assets/logo-helsinki.svg`. If that file is missing, an "H" badge is shown instead.

## Make it your own

Fork it, remix it, improve it, break it. Make games, animations, films, experiments, or something completely different. Use it as a starting point and take it wherever you want. Have fun!

## Ideas

- Real building heights from the 3D city model for collisions and the minimap.
- Denser, more accurate trees from the City of Helsinki tree register (puurekisteri).
- Better ground, roof and water textures from the city's orthophotos.
- Ferries to Suomenlinna from Kauppatori.
- Send a PR. Build the city!

Explore other cities and community remixes in [Slop Cities](https://github.com/zz85/slop-cities).

## License and data

The project code is available under the [MIT License](LICENSE).

Geographic data: © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL). 3D city model and terrain: © City of Helsinki ([Helsingin 3D-kaupunkimalli](https://hri.fi/data/en_GB/dataset/helsingin-3d-kaupunkimalli), CC BY 4.0). Third-party data and dependencies keep their own licenses.