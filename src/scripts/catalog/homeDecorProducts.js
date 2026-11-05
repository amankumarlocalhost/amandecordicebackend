'use strict';

/**
 * Home décor products: two per sub-category of homeDecorTaxonomy.js (146 in total).
 *
 * Row: [name, material, colour, finish, dimensions, weightGrams, mrp, price, blurb, imageQuery, opts?]
 *  - dimensions: "LxWxH" or "dDxH" (D = diameter), in centimetres
 *  - mrp / price: rupees (stored as integer paise by the seed)
 *  - blurb: the product's own short description (unique per product)
 *  - imageQuery: the Unsplash search phrase used to find a representative photograph
 *  - opts.v: variants [[title, mrp, price, size]]; opts.ms: secondary materials; opts.pcs: pieces per set
 */
const PRODUCTS = {
  // ------------------------------------------------------------------ Kitchen
  'kitchen-decor-organizers': [
    ['Minimalist Wooden Kitchen Organizer', 'wood', 'natural oak', 'matte', '32x14x18', 1400, 2499, 1899, 'A three-compartment caddy in solid sheesham that keeps spatulas, oils and tea tins within reach. Rounded edges and a soft oiled finish make it as easy on the eye as it is on the counter.', 'wooden kitchen organizer utensils'],
    ['Bamboo Tiered Counter Organizer', 'bamboo', 'honey', 'lacquered', '38x22x30', 1800, 2799, 2199, 'Two open tiers of sustainably harvested bamboo create a tidy station for jars, mugs and everyday condiments. It assembles in minutes and wipes clean with a damp cloth.', 'bamboo shelf kitchen counter'],
  ],
  'kitchen-spice-racks': [
    ['Premium Ceramic Spice Jar Set', 'ceramic', 'ivory', 'glazed', '30x10x12', 2200, 3299, 2599, 'Six lidded ceramic jars on an acacia base, each glazed in soft ivory and sealed with a cork-lined bamboo lid. Sized for the masalas you reach for every day.', 'ceramic spice jars', { pcs: 6, ms: ['wood'] }],
    ['Two-Tier Acacia Spice Rack', 'wood', 'walnut brown', 'oiled', '40x12x24', 1600, 2199, 1749, 'A wall-or-counter rack in acacia wood with two railed shelves that hold up to 16 standard spice jars. The railings stop jars from tipping when the drawer slams.', 'spice rack wooden'],
  ],
  'kitchen-storage-containers': [
    ['Borosilicate Glass Canister Trio', 'glass', 'clear', 'polished', 'd11x20', 2100, 2999, 2399, 'Three airtight borosilicate canisters with bamboo lids and silicone seals, in graduated sizes for rice, lentils and coffee. Clear walls show you exactly what needs topping up.', 'glass canisters bamboo lids', { pcs: 3, ms: ['bamboo'], v: [['Set of 3', 2999, 2399, 'set of 3'], ['Set of 5', 4499, 3599, 'set of 5']] }],
    ['Stoneware Pantry Jar with Wooden Lid', 'stoneware', 'sage green', 'reactive glaze', 'd14x18', 1300, 1899, 1499, 'A generous stoneware jar finished in a reactive sage glaze, so no two pieces are exactly alike. The fitted mango-wood lid keeps flour, sugar and snacks fresh.', 'stoneware jar wooden lid', { ms: ['wood'] }],
  ],
  'kitchen-serving-accessories': [
    ['Mango Wood Serving Board with Handle', 'wood', 'natural', 'food-safe oil', '45x20x2', 1200, 1799, 1399, 'A long mango-wood board with a carved handle, made for cheese, breads and festive platters. Its live-edge grain makes every board unique.', 'wooden serving board cheese'],
    ['Marble and Brass Serving Stand', 'marble', 'white', 'polished', 'd25x10', 2600, 3999, 3199, 'A white marble plate raised on a brushed brass stem for cakes, desserts and mithai. Cool marble keeps sweets fresh while the brass adds a gentle gleam.', 'marble cake stand', { ms: ['brass'] }],
  ],
  'kitchen-wall-decor': [
    ['Hand-Painted Ceramic Kitchen Wall Plate', 'ceramic', 'indigo and white', 'glazed', 'd25x2', 700, 1499, 1199, 'A hand-painted plate with an indigo botanical motif, fitted with a concealed hanger. Group a few above the hob or the breakfast counter for an easy gallery.', 'blue white plates wall kitchen'],
    ['Wooden Herb Wall Shelf with Hooks', 'wood', 'natural pine', 'matte', '50x12x15', 1500, 1999, 1599, 'A slim pine ledge with four brass hooks beneath — a home for potted herbs above and aprons or mugs below.', 'kitchen wall shelf hooks', { ms: ['brass'] }],
  ],
  'kitchen-decorative-trays': [
    ['Rattan Oval Kitchen Tray', 'rattan', 'natural', 'hand-woven', '40x28x6', 800, 1599, 1249, 'A hand-woven rattan tray with raised sides that gathers oils, salt and pepper beside the stove. Light, sturdy and naturally textured.', 'rattan tray kitchen'],
    ['Terrazzo Counter Tray', 'concrete', 'speckled grey', 'sealed', '30x15x2', 1100, 1699, 1349, 'A cast terrazzo tray flecked with colourful stone chips, sealed against splashes. Perfect under a soap dispenser or a pair of olive-oil bottles.', 'terrazzo tray'],
  ],
  'kitchen-fruit-baskets': [
    ['Black Wire Fruit Basket with Handle', 'iron', 'matte black', 'powder-coated', 'd28x22', 900, 1499, 1149, 'An airy wire basket in powder-coated iron that lets fruit breathe and ripen evenly. The arched handle makes it easy to carry to the table.', 'wire fruit basket'],
    ['Seagrass Fruit Bowl', 'jute', 'natural', 'hand-woven', 'd32x12', 600, 1299, 999, 'A wide, shallow bowl woven from seagrass by artisans in Assam. Ideal for oranges, bananas or a loaf of fresh bread.', 'woven basket fruit'],
  ],
  'kitchen-accessories': [
    ['Speckled Ceramic Utensil Crock', 'ceramic', 'speckled cream', 'satin glaze', 'd12x16', 900, 1299, 999, 'A weighty speckled ceramic crock that holds ladles and whisks without tipping. The satin glaze stays easy to clean.', 'ceramic utensil holder'],
    ['Olive Wood Salt Cellar with Lid', 'wood', 'olive', 'oiled', 'd9x7', 300, 999, 799, 'A swivel-lid salt cellar turned from olive wood, perfect for flaky salt or chilli flakes beside the hob.', 'wooden salt cellar'],
  ],

  // ------------------------------------------------------------------ Gardening
  'gardening-planters': [
    ['Modern Ceramic Decorative Planter', 'ceramic', 'matte white', 'matte glaze', 'd30x32', 4200, 3499, 2799, 'A tall cylinder planter in matte white ceramic with a drainage hole and a matching saucer. Made for a snake plant, fiddle-leaf fig or monstera.', 'white ceramic planter plant', { v: [['Medium', 3499, 2799, 'medium'], ['Large', 4999, 3999, 'large']] }],
    ['Fluted Terracotta Floor Planter', 'terracotta', 'terracotta', 'natural', 'd36x34', 5200, 2999, 2399, 'A ribbed terracotta planter thrown by potters in Khurja. Natural clay lets roots breathe while the fluting adds rhythm to a sunny corner.', 'terracotta pot plant'],
  ],
  'gardening-decorative-plant-pots': [
    ['Speckled Stoneware Plant Pot', 'stoneware', 'oatmeal', 'speckled glaze', 'd15x14', 1100, 1299, 999, 'An oatmeal stoneware pot with charming iron speckles, sized for pothos, peperomia and other easy greens.', 'speckled plant pot'],
    ['Textured Concrete Plant Pot', 'concrete', 'grey', 'raw', 'd18x16', 1800, 1499, 1199, 'A hand-cast concrete pot with a softly pitted surface. Its cool grey makes deep greens look even richer.', 'concrete plant pot'],
  ],
  'gardening-hanging-planters': [
    ['Minimalist Hanging Plant Pot', 'ceramic', 'white', 'matte glaze', 'd16x13', 900, 1399, 1099, 'A rounded white ceramic pot suspended from a natural jute cord. Hang trailing plants at a window and let them tumble.', 'hanging plant pot', { ms: ['jute'] }],
    ['Handknotted Macramé Plant Hanger', 'fabric', 'natural cotton', 'hand-knotted', '25x25x95', 250, 899, 699, 'A 95 cm cotton macramé hanger knotted by hand with a wooden ring. Holds pots up to 20 cm across.', 'macrame plant hanger'],
  ],
  'gardening-artificial-plants': [
    ['Faux Olive Tree in Ceramic Pot', 'other', 'green', 'lifelike', 'd18x90', 2600, 5499, 4399, 'A 90 cm faux olive tree with realistic silvery leaves and a weighted ceramic pot. All the Mediterranean calm, none of the watering.', 'olive tree pot interior'],
    ['Artificial Monstera in Woven Basket', 'other', 'deep green', 'lifelike', 'd22x75', 1900, 3999, 3199, 'A lush faux monstera with split leaves, potted in a hand-woven seagrass basket. Brings jungle energy to rooms with little light.', 'monstera plant basket', { ms: ['jute'] }],
  ],
  'gardening-garden-statues': [
    ['Meditating Buddha Garden Statue', 'resin', 'stone grey', 'weathered', '22x18x35', 2400, 3299, 2599, 'A serene Buddha in weather-resistant resin with a stone-like finish. Place it among plants for a quiet, contemplative corner.', 'buddha statue garden'],
    ['Sandstone Elephant Garden Figure', 'other', 'sand', 'hand-carved', '30x14x22', 4800, 4499, 3599, 'A hand-carved sandstone elephant, trunk raised for good fortune. Ages beautifully outdoors.', 'elephant statue garden'],
  ],
  'gardening-garden-decor-accessories': [
    ['Moroccan Metal Garden Lantern', 'iron', 'antique bronze', 'distressed', '18x18x40', 1600, 2499, 1999, 'A pierced-metal lantern that throws patterned light across a terrace. Holds a pillar candle or a battery fairy light.', 'moroccan lantern garden'],
    ['Copper Bird Feeder', 'copper', 'copper', 'brushed', 'd15x25', 700, 1899, 1499, 'A hanging copper-finish feeder with a seed tray and perch. It weathers to a lovely patina over the seasons.', 'bird feeder garden'],
  ],
  'gardening-tabletop-planters': [
    ['Geometric Ceramic Succulent Planter Set', 'ceramic', 'pastel', 'matte glaze', 'd8x8', 800, 1499, 1199, 'Three faceted mini planters in soft pastels, sized for succulents and cacti on desks and window sills.', 'succulent planters small', { pcs: 3 }],
    ['Brass Tabletop Planter on Stand', 'brass', 'antique gold', 'brushed', 'd12x16', 700, 1799, 1399, 'A small brass bowl planter raised on three slim legs — a jewel-like home for a single trailing plant.', 'brass planter'],
  ],
  'gardening-outdoor-decorative-items': [
    ['Solar Glass Garden Lantern', 'glass', 'clear and black', 'frosted', '14x14x28', 900, 1799, 1399, 'A frosted glass lantern with a solar cap that glows warm white at dusk. No wiring, no candles — just sunlight saved for later.', 'solar lantern outdoor'],
    ['Metal Butterfly Wall Accent for Patio', 'metal', 'multicolour', 'powder-coated', '45x3x35', 600, 1499, 1199, 'Three weather-resistant metal butterflies that bring colour to a balcony wall or garden fence.', 'metal butterfly garden decor', { pcs: 3 }],
  ],

  // ------------------------------------------------------------------ Wall Hanging
  'wall-hanging-metal': [
    ['Abstract Metal Wall Sculpture', 'metal', 'gold', 'brushed', '90x4x45', 2200, 6999, 5499, 'Flowing ribbons of laser-cut metal finished in brushed gold, mounted off the wall so they cast soft shadows. A statement above a sofa or console.', 'gold metal wall art'],
    ['Wrought Iron Tree of Life Wall Hanging', 'iron', 'black', 'powder-coated', '60x2x60', 1800, 3999, 3199, 'A hand-forged iron Tree of Life roundel with fine branches and roots, a symbol of growth and connection.', 'tree of life metal wall'],
  ],
  'wall-hanging-wooden': [
    ['Handmade Wooden Wall Hanging', 'wood', 'natural', 'oiled', '45x2x80', 1200, 2999, 2399, 'Turned wooden beads strung on cotton cord beneath a driftwood bar. Simple, warm and made by hand.', 'wooden bead wall hanging', { ms: ['fabric'] }],
    ['Carved Mango Wood Mandala Panel', 'wood', 'walnut', 'hand-carved', '45x2x45', 1600, 3499, 2799, 'A mandala hand-carved into a single mango-wood panel, with intricate petals that catch the light differently through the day.', 'carved wooden panel'],
  ],
  'wall-hanging-decorative-wall-plates': [
    ['Blue Pottery Decorative Wall Plate', 'ceramic', 'blue and white', 'glazed', 'd25x2', 650, 1699, 1349, 'A Jaipur blue-pottery plate painted by hand with floral motifs in cobalt and turquoise. Comes with a wall hook.', 'blue pottery plate'],
    ['Set of Three Terracotta Wall Plates', 'terracotta', 'terracotta and white', 'hand-painted', 'd20x2', 1500, 2799, 2199, 'Three terracotta plates with white folk-inspired patterns for an earthy gallery wall.', 'decorative plates wall', { pcs: 3 }],
  ],
  'wall-hanging-geometric-wall-art': [
    ['Hexagon Mirror Wall Art Set', 'acrylic', 'gold', 'mirrored', '30x1x26', 500, 1999, 1599, 'Seven hexagonal acrylic mirrors you can arrange as a honeycomb or scatter across a wall. Shatter-resistant and lightweight.', 'hexagon mirror wall', { pcs: 7 }],
    ['Geometric Wooden Line Art', 'mdf', 'black', 'matte', '60x1x60', 1100, 2499, 1999, 'Interlocking geometric lines cut from MDF and finished in matte black — graphic, modern and light enough for adhesive strips.', 'geometric wall art black'],
  ],
  'wall-hanging-bohemian': [
    ['Bohemian Macramé Wall Hanging', 'fabric', 'natural cotton', 'hand-knotted', '60x2x90', 450, 2499, 1999, 'A layered macramé hanging with fringe, knotted by hand from soft cotton cord on a natural wood dowel.', 'macrame wall hanging boho', { ms: ['wood'] }],
    ['Woven Wall Basket Set', 'jute', 'natural and black', 'hand-woven', 'd35x3', 900, 2999, 2399, 'Three flat woven baskets in different sizes and patterns, made to hang together as textured wall art.', 'woven baskets wall', { pcs: 3 }],
  ],
  'wall-hanging-traditional': [
    ['Brass Om Wall Hanging with Bells', 'brass', 'antique brass', 'hand-finished', '20x3x45', 800, 2299, 1799, 'A cast brass Om symbol with a cascade of tiny bells that chime softly in a breeze. Traditionally hung at entrances for blessings.', 'brass bells hanging'],
    ['Madhubani Painted Wooden Toran', 'wood', 'multicolour', 'hand-painted', '90x1x20', 600, 1999, 1599, 'A door toran with Madhubani-style peacocks and lotuses hand-painted on wood, for festivals and every day.', 'traditional indian door hanging'],
  ],
  'wall-hanging-handmade': [
    ['Handwoven Wool Wall Tapestry', 'fabric', 'rust and cream', 'handwoven', '50x2x70', 700, 3499, 2799, 'A loom-woven tapestry in wool and cotton with rust and cream bands. Adds warmth and texture to a plain wall.', 'woven tapestry wall'],
    ['Handmade Dried Flower Wall Wreath', 'other', 'natural', 'dried', 'd40x8', 300, 1999, 1599, 'A rattan hoop dressed with dried pampas, bunny tails and wheat, arranged by hand. Lasts for years without care.', 'dried flower wreath wall', { ms: ['rattan'] }],
  ],

  // ------------------------------------------------------------------ Table Décor
  'table-decor-decorative-trays': [
    ['Marble Coffee Table Tray', 'marble', 'white and grey', 'polished', '35x20x3', 2400, 3499, 2799, 'A white marble tray veined in soft grey, with brass handles. Styles candles, books and a small vase on a coffee table.', 'marble tray coffee table', { ms: ['brass'] }],
    ['Gold Mirror Vanity Tray', 'metal', 'gold', 'mirrored', '30x20x4', 900, 1999, 1599, 'A gold-finished metal tray with a mirrored base that doubles the sparkle of perfumes and jewellery.', 'gold mirror tray perfume'],
  ],
  'table-decor-table-centerpieces': [
    ['Luxury Decorative Centerpiece', 'brass', 'antique gold', 'hand-polished', 'd30x15', 1900, 4999, 3999, 'A hand-beaten brass urli-inspired bowl on a pedestal, made for floating flowers, candles or seasonal fruit.', 'brass bowl centerpiece'],
    ['Long Wooden Candle Centerpiece', 'wood', 'natural', 'oiled', '60x12x6', 1300, 2799, 2199, 'A long mango-wood board with five candle cups, made to run down the middle of a dining table.', 'wooden candle centerpiece table'],
  ],
  'table-decor-decorative-bowls': [
    ['Modern Ceramic Decorative Bowl', 'ceramic', 'sand', 'matte glaze', 'd28x10', 1400, 2499, 1999, 'A wide, low bowl in sand-coloured matte ceramic with an organic, slightly uneven rim. Beautiful empty, or with a few pebbles.', 'ceramic bowl decor'],
    ['Black Marble Decorative Bowl', 'marble', 'black', 'honed', 'd20x8', 2200, 2999, 2399, 'A carved black marble bowl with a honed finish, heavy and cool to the touch. Ideal for keys or a single sculptural object.', 'black marble bowl'],
  ],
  'table-decor-tabletop-sculptures': [
    ['Abstract Ceramic Face Sculpture', 'ceramic', 'white', 'matte', '12x10x25', 900, 2799, 2199, 'A minimalist sculpted face in matte white ceramic, eyes gently closed. Brings a gallery feel to shelves and side tables.', 'abstract face sculpture'],
    ['Brass Abstract Knot Sculpture', 'brass', 'gold', 'polished', '15x10x20', 1100, 3299, 2599, 'A polished brass knot, cast in a single flowing form. A small piece with real presence.', 'brass sculpture decor'],
  ],
  'table-decor-dining-table-accessories': [
    ['Brass Napkin Ring Set of Six', 'brass', 'gold', 'brushed', 'd5x3', 300, 1499, 1199, 'Six brushed brass napkin rings with a hammered texture for festive and everyday tables alike.', 'brass napkin rings table setting', { pcs: 6 }],
    ['Marble Coaster Set with Holder', 'marble', 'white', 'polished', 'd10x1', 900, 1499, 1199, 'Four round marble coasters with cork backs and a brass-finish holder. Protects tables, looks like jewellery.', 'marble coasters', { pcs: 4 }],
  ],
  'table-decor-decorative-figurines': [
    ['Ceramic Bird Figurine Pair', 'ceramic', 'white and gold', 'glazed', '12x6x10', 400, 1799, 1399, 'Two glazed ceramic birds with gold-leaf beaks, made to perch on a bookshelf or bedside table.', 'ceramic bird figurine', { pcs: 2 }],
    ['Resin Elephant Figurine Set', 'resin', 'antique gold', 'hand-painted', '14x6x12', 700, 2199, 1699, 'Three elephants in graduated sizes, hand-painted in antique gold — a classic symbol of wisdom and good luck.', 'elephant figurine decor', { pcs: 3 }],
  ],
  'table-decor-table-runners': [
    ['Handloom Cotton Table Runner', 'fabric', 'ivory and rust', 'handloom', '180x35x1', 350, 1499, 1199, 'A 180 cm handloom cotton runner with rust stripes and tasselled ends, woven on traditional pit looms.', 'table runner dining', { v: [['150 cm', 1299, 1049, '150 cm'], ['180 cm', 1499, 1199, '180 cm']] }],
    ['Jute Placemat Set of Four', 'jute', 'natural', 'braided', 'd38x1', 600, 1299, 999, 'Four round braided jute placemats that bring texture and warmth to the table.', 'jute placemats table', { pcs: 4 }],
  ],

  // ------------------------------------------------------------------ Wall Décor
  'wall-decor-wall-art': [
    ['Botanical Framed Wall Art Set', 'wood', 'sage and cream', 'framed print', '30x2x40', 2400, 4499, 3599, 'Three botanical prints on archival paper in slim oak frames. Calm, fresh and easy to hang as a trio.', 'botanical prints framed wall', { pcs: 3 }],
    ['Large Neutral Canvas Wall Art', 'fabric', 'beige', 'canvas', '90x3x60', 2200, 5999, 4799, 'A large gallery-wrapped canvas with a soft abstract landscape in beige and clay tones.', 'canvas art living room'],
  ],
  'wall-decor-decorative-mirrors': [
    ['Minimalist Decorative Wall Mirror', 'metal', 'gold', 'brushed', 'd60x2', 3800, 5999, 4799, 'A 60 cm round mirror in a slim brushed-gold frame. Opens up an entryway or brightens a powder room.', 'round gold mirror wall'],
    ['Rattan Sunburst Mirror', 'rattan', 'natural', 'hand-woven', 'd70x3', 2500, 5499, 4399, 'A hand-woven rattan sunburst framing a round mirror — relaxed, warm and full of texture.', 'rattan mirror'],
  ],
  'wall-decor-wall-clocks': [
    ['Scandinavian Wooden Wall Clock', 'wood', 'natural and white', 'matte', 'd35x4', 1100, 2799, 2199, 'A silent-sweep wall clock with a natural wood face and white hands. No ticking, just quiet time.', 'wooden wall clock'],
    ['Oversized Metal Skeleton Wall Clock', 'metal', 'black', 'powder-coated', 'd60x5', 1800, 3999, 3199, 'A 60 cm open-frame metal clock with bold Roman numerals, made to anchor a large wall.', 'large wall clock'],
  ],
  'wall-decor-metal-wall-art': [
    ['Abstract Metal Wall Art', 'metal', 'gold and black', 'powder-coated', '100x3x40', 2600, 7499, 5999, 'Layered abstract waves in gold and black metal that add movement and depth to a wide wall.', 'abstract metal wall art'],
    ['Metal Leaf Wall Décor', 'iron', 'antique gold', 'distressed', '70x2x35', 1400, 3299, 2599, 'A spray of hand-cut iron leaves finished in antique gold — organic shapes for a modern wall.', 'metal leaves wall decor'],
  ],
  'wall-decor-wooden-wall-decor': [
    ['Wooden Slat Wall Panel', 'wood', 'walnut', 'oiled', '60x2x60', 2200, 3999, 3199, 'Vertical walnut-finish slats on a felt backing that add warmth and soften sound behind a bed or TV.', 'wooden slat wall'],
    ['Hand-Carved Wooden Jharokha Frame', 'wood', 'distressed white', 'hand-carved', '40x5x60', 2800, 6499, 5199, 'A miniature Rajasthani jharokha window carved by hand and finished in distressed white — heritage craft for modern walls.', 'carved wooden window frame'],
  ],
  'wall-decor-abstract-wall-decor': [
    ['Textured Abstract Canvas Painting', 'fabric', 'ivory and terracotta', 'hand-painted', '60x3x90', 1900, 6999, 5599, 'A hand-painted textured canvas with sweeping terracotta forms on ivory. Each piece is unique.', 'abstract painting textured'],
    ['Abstract Line Face Framed Print', 'wood', 'black and white', 'framed print', '40x2x50', 1300, 1999, 1599, 'A single-line abstract face drawing printed on matte paper in a black wooden frame.', 'line art print frame'],
  ],
  'wall-decor-wall-shelves': [
    ['Floating Wooden Wall Shelf Set', 'wood', 'natural oak', 'matte', '60x15x4', 3200, 2999, 2399, 'Two floating shelves in oak finish with hidden brackets, for books, plants and frames.', 'floating shelves wall decor', { pcs: 2, v: [['60 cm', 2999, 2399, '60 cm'], ['90 cm', 3999, 3199, '90 cm']] }],
    ['Hexagon Wooden Wall Shelf', 'mdf', 'white', 'lacquered', '30x12x26', 1100, 1499, 1199, 'A hexagonal display shelf in white lacquered MDF, perfect for a small plant or a favourite figurine. Combine several for a honeycomb.', 'hexagon shelf wall'],
  ],
  'wall-decor-decorative-signs': [
    ['Engraved Wooden "Home" Sign', 'wood', 'natural', 'engraved', '45x2x15', 600, 1299, 999, 'A solid wood sign engraved with "Home" in a flowing script — warm welcome for a hallway or mantel.', 'wooden home sign'],
    ['Personalised Brass Name Plate', 'brass', 'gold', 'etched', '30x1x12', 700, 2499, 1999, 'An etched brass name plate on a teak backing, personalised with your family name at checkout.', 'brass name plate door'],
  ],

  // ------------------------------------------------------------------ Glass
  'glass-decorative-bottles': [
    ['Amber Glass Decorative Bottle', 'glass', 'amber', 'mouth-blown', 'd10x30', 600, 1499, 1199, 'A slender mouth-blown bottle in warm amber glass that glows when sunlight passes through. Lovely alone or with a single dried stem.', 'amber glass bottle'],
    ['Set of Three Smoked Glass Bottles', 'glass', 'smoke grey', 'mouth-blown', 'd8x25', 1100, 2499, 1999, 'Three smoky-grey bottles of different heights for an effortless shelf vignette.', 'glass bottles shelf decor', { pcs: 3 }],
  ],
  'glass-jars': [
    ['Premium Textured Glass Jar', 'glass', 'clear', 'textured', 'd12x18', 700, 1499, 1199, 'A thick-walled glass jar with a hobnail texture and a fitted glass lid, for cotton buds, bath salts or sweets.', 'glass jar textured'],
    ['Apothecary Glass Jar with Wooden Lid', 'glass', 'clear', 'polished', 'd14x22', 900, 1299, 999, 'A classic apothecary jar with an acacia lid — equally at home in the bathroom, kitchen or study.', 'apothecary jar', { ms: ['wood'] }],
  ],
  'glass-vases': [
    ['Bubble Glass Vase', 'glass', 'clear', 'mouth-blown', 'd15x20', 800, 1799, 1399, 'A round mouth-blown vase with tiny air bubbles suspended in the glass, made for a loose handful of garden flowers.', 'bubble glass vase'],
    ['Tinted Pink Glass Bud Vase', 'glass', 'blush pink', 'polished', 'd7x18', 300, 899, 699, 'A slim bud vase in blush-tinted glass for a single rose, tulip or eucalyptus sprig.', 'pink glass vase'],
  ],
  'glass-decorative-bowls': [
    ['Ribbed Glass Decorative Bowl', 'glass', 'clear', 'ribbed', 'd25x10', 1300, 1999, 1599, 'A wide ribbed glass bowl that refracts light into soft lines — for fruit, potpourri or floating candles.', 'ribbed glass bowl'],
    ['Amber Glass Footed Bowl', 'glass', 'amber', 'pressed', 'd20x14', 1100, 1799, 1399, 'A vintage-inspired footed bowl in amber pressed glass with a scalloped rim.', 'amber glass bowl'],
  ],
  'glass-candle-holders': [
    ['Glass Hurricane Candle Holder', 'glass', 'clear', 'mouth-blown', 'd15x30', 1600, 2499, 1999, 'A tall glass hurricane on a mango-wood base that shields a pillar candle from breezes.', 'hurricane candle holder', { ms: ['wood'] }],
    ['Set of Four Fluted Glass Votives', 'glass', 'smoke', 'fluted', 'd8x9', 900, 1499, 1199, 'Four fluted smoke-glass votives that scatter soft light across a table.', 'glass votive candles', { pcs: 4 }],
  ],
  'glass-colored-decor': [
    ['Cobalt Blue Glass Decorative Orb', 'glass', 'cobalt blue', 'hand-blown', 'd12x12', 600, 1299, 999, 'A hand-blown orb in deep cobalt glass. Group with clear and amber pieces for a jewel-toned shelf.', 'blue glass decor'],
    ['Green Glass Carafe Vase', 'glass', 'bottle green', 'recycled glass', 'd12x28', 900, 1699, 1349, 'A carafe-shaped vase made from recycled bottle-green glass, with gentle ripples from the mould.', 'green glass vase'],
  ],
  'glass-artistic-accessories': [
    ['Murano-Style Art Glass Paperweight', 'glass', 'multicolour', 'hand-blown', 'd8x7', 500, 1499, 1199, 'A hand-blown glass paperweight with swirls of colour suspended inside. A tiny artwork for a desk.', 'art glass paperweight'],
    ['Hand-Blown Glass Abstract Sculpture', 'glass', 'clear and teal', 'hand-blown', '15x10x30', 1300, 4999, 3999, 'A flowing abstract sculpture in clear and teal glass, shaped by hand so every piece differs.', 'glass sculpture art'],
  ],

  // ------------------------------------------------------------------ Vases
  'vases-ceramic-vases': [
    ['Sculptural Ceramic Vase', 'ceramic', 'matte white', 'matte glaze', 'd16x30', 1400, 2999, 2399, 'A softly asymmetric vase in matte white ceramic, thrown and then gently pressed into shape by hand.', 'white ceramic vase', { v: [['Small', 2299, 1849, 'small'], ['Large', 2999, 2399, 'large']] }],
    ['Reactive Glaze Ceramic Vase', 'ceramic', 'ocean blue', 'reactive glaze', 'd14x25', 1200, 2499, 1999, 'A reactive glaze pools and breaks over this bellied vase in shades of ocean blue — each one unique.', 'blue glaze ceramic vase'],
  ],
  'vases-glass-vases': [
    ['Minimalist Ribbed Glass Vase', 'glass', 'clear', 'ribbed', 'd12x25', 900, 1999, 1599, 'A cylindrical vase in thick ribbed glass that makes even a few stems look considered.', 'ribbed glass vase'],
    ['Smoked Glass Bud Vase Trio', 'glass', 'smoke grey', 'mouth-blown', 'd6x15', 700, 1699, 1349, 'Three small bud vases in smoked glass for a row of single blooms along a sill or table.', 'glass bud vases', { pcs: 3 }],
  ],
  'vases-metal-vases': [
    ['Hammered Brass Vase', 'brass', 'antique gold', 'hand-hammered', 'd12x24', 1100, 3299, 2599, 'Hand-hammered brass with a soft antique finish, shaped by metalsmiths in Moradabad.', 'brass vase'],
    ['Matte Black Iron Vase', 'iron', 'matte black', 'powder-coated', 'd10x30', 1200, 1999, 1599, 'A tall, slim vase in powder-coated iron with a watertight liner, for dramatic branches and dried stems.', 'black metal vase'],
  ],
  'vases-wooden-vases': [
    ['Turned Mango Wood Vase', 'wood', 'natural', 'oiled', 'd12x28', 900, 2299, 1799, 'A vase turned from a single block of mango wood, with grain that swirls around its curves. For dried flowers and grasses.', 'wooden vase dried flowers'],
    ['Burnt Wood Bottle Vase', 'wood', 'charcoal', 'shou sugi ban', 'd10x26', 700, 2499, 1999, 'A bottle-shaped vase charred by hand in the shou sugi ban style for a deep, textured black.', 'dark wooden vase'],
  ],
  'vases-modern-sculptural': [
    ['Donut Ring Ceramic Vase', 'ceramic', 'white', 'matte glaze', '22x8x24', 1100, 2799, 2199, 'A ring-shaped vase with a small neck for one or two stems — part vase, part sculpture.', 'ring vase ceramic'],
    ['Organic Wave Sculptural Vase', 'stoneware', 'sand', 'textured', '18x12x30', 1500, 3499, 2799, 'A wave-formed stoneware vase with a sandy textured surface, inspired by dunes.', 'sculptural vase'],
  ],
  'vases-minimalist': [
    ['Matte Beige Minimalist Vase', 'ceramic', 'beige', 'matte glaze', 'd12x22', 900, 1799, 1399, 'A clean cylinder in warm beige matte ceramic — the quiet backdrop every bouquet needs.', 'beige vase minimal'],
    ['Slim Black Minimalist Bottle Vase', 'ceramic', 'black', 'matte glaze', 'd8x28', 800, 1599, 1249, 'A narrow-necked bottle vase in matte black for a single dramatic stem.', 'black vase minimal'],
  ],
  'vases-floor-vases': [
    ['Tall Ribbed Floor Vase', 'ceramic', 'ivory', 'matte glaze', 'd25x60', 5200, 6999, 5599, 'A 60 cm fluted floor vase in ivory, made for pampas, palm leaves or branches in a bare corner.', 'tall floor vase pampas'],
    ['Woven Seagrass Floor Vase', 'jute', 'natural', 'hand-woven', 'd22x70', 1100, 3999, 3199, 'A 70 cm seagrass floor vase with a removable liner, hand-woven for natural texture.', 'woven floor vase'],
  ],
  'vases-tabletop-vases': [
    ['Mini Terracotta Vase Set', 'terracotta', 'terracotta', 'natural', 'd8x10', 900, 1499, 1199, 'Three small terracotta vases in different shapes, for little posies on tables and shelves.', 'small terracotta vases', { pcs: 3 }],
    ['Speckled Stoneware Bud Vase', 'stoneware', 'oatmeal', 'speckled glaze', 'd8x14', 450, 999, 799, 'A petite bud vase in speckled oatmeal stoneware, glazed inside to hold water.', 'speckled bud vase'],
  ],

  // ------------------------------------------------------------------ Photo Frames
  'photo-frames-wooden': [
    ['Premium Wooden Photo Frame', 'wood', 'walnut', 'oiled', '20x2x25', 500, 1299, 999, 'A solid walnut-finish frame with a bevelled mount and real glass, for a 5×7 inch photograph.', 'wooden photo frame', { v: [['5x7 inch', 1299, 999, '5x7'], ['8x10 inch', 1799, 1399, '8x10']] }],
    ['Rustic Reclaimed Wood Frame', 'wood', 'weathered grey', 'distressed', '25x2x30', 600, 1499, 1199, 'A frame made from reclaimed wood with weathered grey tones and nail-hole character. Holds a 6×8 inch print.', 'rustic wooden frame'],
  ],
  'photo-frames-metal': [
    ['Minimalist Metal Photo Frame', 'metal', 'gold', 'brushed', '15x1x20', 400, 1199, 949, 'A slim brushed-gold metal frame with a glass front, for a 4×6 inch photograph on a desk or shelf.', 'gold photo frame', { v: [['4x6 inch', 1199, 949, '4x6'], ['5x7 inch', 1499, 1199, '5x7']] }],
    ['Matte Black Aluminium Frame', 'aluminium', 'matte black', 'anodised', '23x1x28', 450, 1399, 1099, 'A thin anodised aluminium frame in matte black with a white mount — gallery style for 6×8 inch prints.', 'black frame photo'],
  ],
  'photo-frames-tabletop': [
    ['Tabletop Glass Float Frame', 'glass', 'clear and gold', 'polished', '18x6x23', 700, 1599, 1249, 'Two panes of glass hold a photograph seemingly in mid-air, with a gold-finish stand.', 'glass photo frame table'],
    ['Leather-Look Tabletop Frame', 'other', 'tan', 'stitched', '15x2x20', 350, 1299, 999, 'A tan vegan-leather frame with contrast stitching and an easel back, for 4×6 inch photographs.', 'photo frame desk'],
  ],
  'photo-frames-wall': [
    ['Gallery Wall Frame Set of Six', 'wood', 'black', 'matte', '30x2x40', 3200, 4999, 3999, 'Six black wooden frames in mixed sizes with mounts and a paper hanging template for a perfect gallery wall.', 'gallery wall frames', { pcs: 6 }],
    ['Large Oak Wall Frame', 'wood', 'natural oak', 'matte', '50x3x70', 1800, 2999, 2399, 'A 50×70 cm oak-finish frame with an acrylic front, for posters and large prints.', 'large wooden frame wall'],
  ],
  'photo-frames-collage': [
    ['Twelve-Opening Collage Frame', 'mdf', 'white', 'matte', '60x2x45', 1900, 2499, 1999, 'One white frame with twelve 4×6 inch openings — a whole year of memories on one wall.', 'collage photo frame'],
    ['Hanging Photo Clip Display', 'wood', 'natural', 'oiled', '60x2x80', 500, 1499, 1199, 'A wooden bar with jute strings and 24 mini pegs to clip photographs, postcards and notes.', 'photo display clips string'],
  ],
  'photo-frames-minimalist': [
    ['Thin Profile Brass Frame', 'brass', 'gold', 'polished', '13x1x18', 300, 1399, 1099, 'An ultra-thin solid brass frame that lets the photograph take centre stage. For 5×7 inch prints.', 'thin brass frame'],
    ['Floating Acrylic Frame', 'acrylic', 'clear', 'polished', '15x3x20', 600, 1199, 949, 'A crystal-clear acrylic block with magnetic closure that makes a photograph look suspended.', 'acrylic photo frame'],
  ],
  'photo-frames-decorative': [
    ['Ornate Antique Gold Photo Frame', 'resin', 'antique gold', 'gilded', '20x2x25', 700, 1899, 1499, 'A baroque-inspired frame with scrolling details in antique gold — for heirloom portraits and wedding photographs.', 'ornate gold frame'],
    ['Mother of Pearl Inlay Frame', 'other', 'white', 'inlaid', '18x2x23', 600, 2799, 2199, 'A frame inlaid by hand with mother-of-pearl in a delicate floral pattern.', 'mother of pearl frame'],
  ],

  // ------------------------------------------------------------------ Candle Stand
  'candle-stand-metal': [
    ['Luxury Brass Candle Stand', 'brass', 'gold', 'polished', 'd10x30', 900, 2999, 2399, 'A tall brass candlestick with a turned stem and weighted base, for dinner tapers that make an occasion.', 'brass candlestick', { v: [['Single', 2999, 2399, 'single'], ['Pair', 5499, 4399, 'pair']] }],
    ['Iron Pillar Candle Stand Trio', 'iron', 'matte black', 'powder-coated', 'd12x40', 2400, 3499, 2799, 'Three slim iron stands in graduated heights for pillar candles — a striking group on a mantel.', 'black metal candle stands', { pcs: 3 }],
  ],
  'candle-stand-wooden': [
    ['Turned Mango Wood Candle Stand', 'wood', 'natural', 'oiled', 'd10x20', 600, 1499, 1199, 'A chunky candle stand turned from mango wood, topped with a brass cup for a pillar candle.', 'wooden candle holder', { ms: ['brass'] }],
    ['Wooden Bead Candle Holder Set', 'wood', 'natural and white', 'matte', 'd8x15', 500, 1299, 999, 'Two candle holders made of stacked wooden beads, one natural and one whitewashed.', 'wooden bead candle holder', { pcs: 2 }],
  ],
  'candle-stand-glass-candle-holders': [
    ['Clear Glass Taper Candle Holder', 'glass', 'clear', 'polished', 'd9x12', 400, 999, 799, 'A solid clear glass holder with a deep socket that keeps taper candles upright and steady.', 'glass taper candle holder'],
    ['Amber Glass Pillar Holder', 'glass', 'amber', 'mouth-blown', 'd12x15', 600, 1299, 999, 'An amber glass cylinder that wraps a pillar candle in a warm honey glow.', 'amber glass candle'],
  ],
  'candle-stand-decorative': [
    ['Moroccan Mosaic Candle Holder', 'glass', 'multicolour', 'mosaic', 'd10x12', 500, 1499, 1199, 'Hand-set coloured glass mosaic that throws jewel-toned light around a room.', 'mosaic candle holder'],
    ['Lotus Brass Diya Candle Holder', 'brass', 'antique brass', 'hand-cast', 'd12x6', 400, 1299, 999, 'A cast brass lotus that holds a tealight or ghee diya — for puja rooms and festive evenings.', 'brass diya'],
  ],
  'candle-stand-tealight-holders': [
    ['Modern Glass Tealight Holder', 'glass', 'clear', 'faceted', 'd7x7', 600, 999, 799, 'Six faceted glass tealight holders that turn small flames into a field of sparkle.', 'glass tealight holders', { pcs: 6 }],
    ['Brass Hexagon Tealight Holder Set', 'brass', 'gold', 'brushed', '8x7x5', 500, 1299, 999, 'Three hexagonal brushed-brass tealight holders — simple geometry, warm glow.', 'brass tealight holder', { pcs: 3 }],
  ],
  'candle-stand-pillar-candle-holders': [
    ['Marble Pillar Candle Plate', 'marble', 'white', 'polished', 'd15x2', 900, 1299, 999, 'A round white marble plate for a pillar candle, protecting surfaces from wax with understated style.', 'marble candle plate pillar candle'],
    ['Ceramic Pillar Candle Stand', 'ceramic', 'sand', 'matte glaze', 'd12x18', 900, 1599, 1249, 'A pedestal stand in sand-coloured matte ceramic that lifts a pillar candle to eye level.', 'ceramic candle holder'],
  ],
  'candle-stand-luxury': [
    ['Five-Arm Brass Candelabra', 'brass', 'antique gold', 'hand-polished', '40x10x45', 2600, 8999, 7199, 'A five-arm brass candelabra with an antique finish, the centrepiece of grand dinners and festive tables.', 'candelabra brass'],
    ['Crystal Glass Candle Stand Pair', 'crystal_glass', 'clear', 'cut crystal', 'd9x25', 1600, 5999, 4799, 'Two cut-crystal candlesticks whose facets catch every flicker of flame.', 'crystal candlesticks', { pcs: 2 }],
  ],

  // ------------------------------------------------------------------ Key Holder
  'key-holder-wooden': [
    ['Wooden Wall Mounted Key Holder', 'wood', 'natural', 'oiled', '30x6x15', 600, 1499, 1199, 'A sheesham wood key board with five brass hooks and a narrow shelf on top for letters or sunglasses.', 'wooden key holder wall', { ms: ['brass'] }],
    ['House-Shaped Wooden Key Rack', 'wood', 'white and natural', 'painted', '25x4x20', 400, 999, 799, 'A little house-shaped key rack with four hooks — a charming welcome by the front door.', 'house key holder wooden'],
  ],
  'key-holder-metal': [
    ['Modern Metal Key Holder', 'metal', 'matte black', 'powder-coated', '35x5x10', 500, 1299, 999, 'A sleek powder-coated metal rack with six hooks and a minimal bar profile.', 'black metal hooks wall'],
    ['Brass Key Hook Rail', 'brass', 'gold', 'brushed', '40x4x6', 600, 1799, 1399, 'Five solid brass hooks on a brushed brass rail — timeless and built to last.', 'brass hooks wall'],
  ],
  'key-holder-wall-mounted': [
    ['Entryway Key Holder with Mail Shelf', 'wood', 'walnut', 'matte', '40x10x22', 1300, 2299, 1799, 'A wall organiser with a mail slot, a top shelf and six hooks to keep the entryway clutter-free.', 'entryway organizer wall'],
    ['Magnetic Wooden Key Bar', 'wood', 'natural oak', 'oiled', '30x3x5', 300, 1199, 949, 'A minimal oak bar with hidden magnets that catch keys with a satisfying click — no hooks needed.', 'magnetic key holder'],
  ],
  'key-holder-decorative': [
    ['Peacock Decorative Key Holder', 'metal', 'multicolour', 'hand-painted', '35x3x25', 500, 1599, 1249, 'A hand-painted metal peacock whose tail feathers end in six key hooks.', 'decorative key holder wall'],
    ['Floral Ceramic Tile Key Holder', 'ceramic', 'blue and white', 'glazed', '30x4x12', 700, 1499, 1199, 'A hand-painted blue-and-white tile on a wood backing with four antique hooks.', 'ceramic tile hooks', { ms: ['wood'] }],
  ],
  'key-holder-modern': [
    ['Geometric Acrylic Key Holder', 'acrylic', 'clear and gold', 'polished', '25x3x12', 300, 999, 799, 'A clear acrylic panel with gold-finish hooks — a light, modern touch for small entryways.', 'modern key holder wall'],
    ['Minimal Pegboard Key Organiser', 'wood', 'white', 'matte', '40x4x30', 1100, 2499, 1999, 'A white pegboard with movable wooden pegs and a small shelf, so you can arrange hooks around your life.', 'pegboard entryway'],
  ],
  'key-holder-handmade': [
    ['Handmade Driftwood Key Holder', 'wood', 'weathered', 'natural', '40x5x10', 500, 1699, 1349, 'A piece of seasoned driftwood fitted with hand-forged iron hooks — each one has its own shape.', 'driftwood hooks wall', { ms: ['iron'] }],
    ['Hand-Painted Wooden Key Holder', 'wood', 'multicolour', 'hand-painted', '30x3x15', 400, 1399, 1099, 'A wooden key holder hand-painted with folk motifs by artisans in Rajasthan.', 'hand painted wooden key holder'],
  ],
};

module.exports = { PRODUCTS };
