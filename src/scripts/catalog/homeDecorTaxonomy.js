'use strict';

/**
 * Home décor master catalog: 10 parent categories and 73 sub-categories (level 1 of the existing
 * Category tree), plus the six "Shop by Space" discovery collections.
 *
 * Slugs are the stable identity used by seedHomeDecorCatalog.js. Sub-category slugs are prefixed with
 * their parent because several names repeat across parents (Decorative Trays, Glass Vases, Glass Candle
 * Holders) and a few unprefixed slugs (ceramic-vases, decorative-bowls, table-centerpieces) already
 * belong to the crockery catalog. Names, descriptions, images and order stay editable in the admin.
 *
 * `code` prefixes SKUs; `keywords` tell the image import what a relevant photo shows; `q` is the
 * Unsplash search phrase for the category's own image; `spaces` maps products to discovery collections.
 */

const DECOR_TAXONOMY = [
  {
    name: 'Kitchen',
    slug: 'kitchen',
    code: 'KIT',
    description: 'Organisers, storage and serving pieces that make the kitchen as beautiful as it is practical.',
    q: 'minimal kitchen interior shelf',
    spaces: ['kitchen', 'dining-room'],
    keywords: ['kitchen', 'jar', 'jars', 'shelf', 'spice', 'container', 'tray', 'basket', 'wooden', 'counter', 'storage', 'utensils', 'bowl'],
    children: [
      ['Kitchen Organizers', 'kitchen-decor-organizers', 'caddies, stands and racks that keep counters calm', 'kitchen organizer wooden counter'],
      ['Spice Racks', 'kitchen-spice-racks', 'racks and jar sets for your everyday masalas', 'spice jars rack kitchen'],
      ['Storage Containers', 'kitchen-storage-containers', 'airtight jars and canisters for pantry staples', 'glass storage jars pantry'],
      ['Serving Accessories', 'kitchen-serving-accessories', 'boards, spoons and stands for serving with style', 'wooden serving board kitchen'],
      ['Kitchen Wall Décor', 'kitchen-wall-decor', 'wall pieces made for the heart of the home', 'kitchen wall decor shelf'],
      ['Decorative Trays', 'kitchen-decorative-trays', 'trays that corral oils, jars and the morning tea', 'kitchen tray counter'],
      ['Fruit Baskets', 'kitchen-fruit-baskets', 'baskets and bowls that keep fruit on show', 'fruit basket kitchen'],
      ['Kitchen Accessories', 'kitchen-accessories', 'small finishing touches for a well-kept kitchen', 'kitchen accessories utensils'],
    ],
  },
  {
    name: 'Gardening',
    slug: 'gardening',
    code: 'GDN',
    description: 'Planters, pots and garden accents to bring greenery indoors and dress balconies and terraces.',
    q: 'balcony plants planters',
    spaces: ['balcony-garden', 'living-room'],
    keywords: ['plant', 'plants', 'planter', 'pot', 'pots', 'garden', 'succulent', 'green', 'leaf', 'leaves', 'balcony', 'terracotta', 'botanical'],
    children: [
      ['Planters', 'gardening-planters', 'statement planters for floor and corner greens', 'ceramic planter indoor plant'],
      ['Decorative Plant Pots', 'gardening-decorative-plant-pots', 'glazed and textured pots for everyday plants', 'decorative plant pot'],
      ['Hanging Planters', 'gardening-hanging-planters', 'macramé, metal and ceramic planters that float', 'hanging planter macrame'],
      ['Artificial Plants', 'gardening-artificial-plants', 'lifelike faux greens that never need watering', 'potted plant interior corner'],
      ['Garden Statues', 'gardening-garden-statues', 'sculptures and figures for gardens and terraces', 'garden statue sculpture'],
      ['Garden Décor Accessories', 'gardening-garden-decor-accessories', 'lanterns, stakes and accents for outdoor corners', 'garden lantern decor'],
      ['Tabletop Planters', 'gardening-tabletop-planters', 'compact planters for desks, sills and shelves', 'succulent small pot table'],
      ['Outdoor Decorative Items', 'gardening-outdoor-decorative-items', 'weather-friendly décor for patios and balconies', 'patio outdoor decor'],
    ],
  },
  {
    name: 'Wall Hanging',
    slug: 'wall-hanging',
    code: 'WHG',
    description: 'Handcrafted wall hangings in metal, wood and fibre that give bare walls a story.',
    q: 'wall hanging boho interior',
    spaces: ['living-room', 'bedroom', 'entryway'],
    keywords: ['wall', 'hanging', 'macrame', 'art', 'decor', 'interior', 'metal', 'wooden', 'boho', 'plate', 'handmade', 'woven'],
    children: [
      ['Metal Wall Hangings', 'wall-hanging-metal', 'cut and forged metal pieces with depth and shadow', 'metal wall art'],
      ['Wooden Wall Hangings', 'wall-hanging-wooden', 'carved and turned wood pieces with warm grain', 'wooden wall decor'],
      ['Decorative Wall Plates', 'wall-hanging-decorative-wall-plates', 'painted and glazed plates arranged as wall art', 'decorative plates wall'],
      ['Geometric Wall Art', 'wall-hanging-geometric-wall-art', 'clean-lined geometric forms for modern walls', 'geometric wall art'],
      ['Bohemian Wall Hangings', 'wall-hanging-bohemian', 'macramé and woven hangings with a relaxed spirit', 'macrame wall hanging'],
      ['Traditional Wall Hangings', 'wall-hanging-traditional', 'motifs and craft traditions from across India', 'traditional indian wall decor'],
      ['Handmade Wall Décor', 'wall-hanging-handmade', 'one-of-a-kind pieces made by hand', 'handmade wall hanging'],
    ],
  },
  {
    name: 'Table Décor',
    slug: 'table-decor',
    code: 'TBL',
    description: 'Centrepieces, bowls, trays and sculptures that finish a dining table, console or coffee table.',
    q: 'table decor centerpiece',
    spaces: ['dining-room', 'living-room'],
    keywords: ['table', 'centerpiece', 'bowl', 'tray', 'sculpture', 'figurine', 'decor', 'dining', 'runner', 'candle', 'vase', 'coffee table'],
    children: [
      ['Decorative Trays', 'table-decor-decorative-trays', 'styling trays for coffee tables and consoles', 'decorative tray coffee table'],
      ['Table Centerpieces', 'table-decor-table-centerpieces', 'statement pieces for the centre of the table', 'table centerpiece decor'],
      ['Decorative Bowls', 'table-decor-decorative-bowls', 'display bowls in marble, wood and metal', 'decorative bowl table'],
      ['Tabletop Sculptures', 'table-decor-tabletop-sculptures', 'abstract and figurative sculptures for shelves', 'abstract sculpture decor'],
      ['Dining Table Accessories', 'table-decor-dining-table-accessories', 'napkin rings, coasters and table finishing touches', 'dining table setting'],
      ['Decorative Figurines', 'table-decor-decorative-figurines', 'collectable figurines with character', 'decorative figurine shelf'],
      ['Table Runners and Accessories', 'table-decor-table-runners', 'runners, mats and accents that dress the table', 'table runner dining'],
    ],
  },
  {
    name: 'Wall Décor',
    slug: 'wall-decor',
    code: 'WDC',
    description: 'Mirrors, clocks, shelves and art that shape a room from the walls in.',
    q: 'wall decor living room art',
    spaces: ['living-room', 'bedroom', 'entryway'],
    keywords: ['wall', 'mirror', 'clock', 'art', 'frame', 'shelf', 'interior', 'decor', 'living room', 'abstract', 'sign', 'painting'],
    children: [
      ['Wall Art', 'wall-decor-wall-art', 'framed prints and canvases for every room', 'framed wall art living room'],
      ['Decorative Mirrors', 'wall-decor-decorative-mirrors', 'mirrors that open up and brighten a space', 'decorative wall mirror'],
      ['Wall Clocks', 'wall-decor-wall-clocks', 'clocks that keep time with style', 'wall clock interior'],
      ['Metal Wall Art', 'wall-decor-metal-wall-art', 'sculpted metal art with a modern edge', 'metal wall sculpture'],
      ['Wooden Wall Décor', 'wall-decor-wooden-wall-decor', 'panels, plaques and carvings in natural wood', 'wooden wall panel decor'],
      ['Abstract Wall Décor', 'wall-decor-abstract-wall-decor', 'expressive abstract pieces in calm palettes', 'abstract wall painting'],
      ['Wall Shelves', 'wall-decor-wall-shelves', 'floating and display shelves for curated objects', 'floating wall shelf decor'],
      ['Decorative Signs', 'wall-decor-decorative-signs', 'lettered and illustrated signs for a personal touch', 'decorative sign wall'],
    ],
  },
  {
    name: 'Glass',
    slug: 'glass',
    code: 'GLA',
    description: 'Mouth-blown and moulded glass décor — bottles, jars, bowls and holders that play with light.',
    q: 'decorative glass bottles light',
    spaces: ['living-room', 'dining-room'],
    keywords: ['glass', 'bottle', 'jar', 'vase', 'bowl', 'candle', 'amber', 'clear', 'transparent', 'light', 'colored', 'ribbed'],
    children: [
      ['Decorative Glass Bottles', 'glass-decorative-bottles', 'sculptural bottles for shelves and sills', 'glass bottles decor'],
      ['Glass Jars', 'glass-jars', 'lidded jars for display and storage', 'glass jar lid'],
      ['Glass Vases', 'glass-vases', 'clear, tinted and textured glass vases', 'glass vase flowers'],
      ['Decorative Glass Bowls', 'glass-decorative-bowls', 'glass bowls for fruit, potpourri or display', 'glass bowl decor'],
      ['Glass Candle Holders', 'glass-candle-holders', 'hurricanes and votives that soften candlelight', 'glass candle holder'],
      ['Colored Glass Décor', 'glass-colored-decor', 'tinted glass pieces in jewel and earthy tones', 'colored glass decor'],
      ['Artistic Glass Accessories', 'glass-artistic-accessories', 'art-glass objects with a crafted finish', 'art glass sculpture'],
    ],
  },
  {
    name: 'Vases',
    slug: 'vases',
    code: 'VAS',
    description: 'Ceramic, glass, metal and wooden vases for fresh blooms, dried stems or simply on their own.',
    q: 'ceramic vases interior',
    spaces: ['living-room', 'dining-room', 'bedroom'],
    keywords: ['vase', 'vases', 'flowers', 'ceramic', 'stems', 'dried', 'pottery', 'decor', 'interior', 'sculptural', 'shelf', 'bouquet'],
    children: [
      ['Ceramic Vases', 'vases-ceramic-vases', 'glazed and matte ceramic vases', 'ceramic vase'],
      ['Glass Vases', 'vases-glass-vases', 'glass vases for fresh flowers', 'glass vase'],
      ['Metal Vases', 'vases-metal-vases', 'brass, copper and iron vases', 'brass vase'],
      ['Wooden Vases', 'vases-wooden-vases', 'turned wood vases for dried stems', 'wooden vase dried flowers'],
      ['Modern Sculptural Vases', 'vases-modern-sculptural', 'vases with organic and architectural forms', 'sculptural vase'],
      ['Minimalist Vases', 'vases-minimalist', 'quiet shapes in neutral tones', 'minimalist white vase'],
      ['Floor Vases', 'vases-floor-vases', 'tall vases that anchor a corner', 'tall floor vase pampas'],
      ['Tabletop Vases', 'vases-tabletop-vases', 'compact vases for tables and shelves', 'small vase table flowers'],
    ],
  },
  {
    name: 'Photo Frames',
    slug: 'photo-frames',
    code: 'PHF',
    description: 'Frames in wood, metal and mixed materials for the photographs that make a house a home.',
    q: 'photo frames shelf',
    spaces: ['living-room', 'bedroom'],
    keywords: ['frame', 'frames', 'photo', 'picture', 'wall', 'shelf', 'gallery', 'wooden', 'metal', 'collage', 'memories', 'table'],
    children: [
      ['Wooden Photo Frames', 'photo-frames-wooden', 'warm wood frames in natural finishes', 'wooden photo frame'],
      ['Metal Photo Frames', 'photo-frames-metal', 'slim metal frames in brass and matte black', 'metal photo frame'],
      ['Tabletop Photo Frames', 'photo-frames-tabletop', 'standing frames for desks and bedsides', 'photo frame table'],
      ['Wall Photo Frames', 'photo-frames-wall', 'frames for building a gallery wall', 'gallery wall frames'],
      ['Collage Photo Frames', 'photo-frames-collage', 'multi-opening frames for a story in pictures', 'collage photo frame'],
      ['Minimalist Photo Frames', 'photo-frames-minimalist', 'thin profiles that let the picture lead', 'minimalist frame'],
      ['Decorative Photo Frames', 'photo-frames-decorative', 'ornate and embellished frames for keepsakes', 'ornate photo frame'],
    ],
  },
  {
    name: 'Candle Stand',
    slug: 'candle-stand',
    code: 'CDL',
    description: 'Candle stands, holders and tealight pieces for a warm, golden glow.',
    q: 'candle holders candlelight interior',
    spaces: ['dining-room', 'living-room', 'bedroom'],
    keywords: ['candle', 'candles', 'candlestick', 'holder', 'tealight', 'light', 'flame', 'brass', 'glow', 'pillar', 'votive', 'lantern'],
    children: [
      ['Metal Candle Stands', 'candle-stand-metal', 'brass, iron and steel stands for tapers and pillars', 'metal candlestick'],
      ['Wooden Candle Stands', 'candle-stand-wooden', 'turned wood stands with a natural finish', 'wooden candle holder'],
      ['Glass Candle Holders', 'candle-stand-glass-candle-holders', 'clear and tinted glass holders', 'glass candle holder'],
      ['Decorative Candle Holders', 'candle-stand-decorative', 'ornamental holders that double as décor', 'decorative candle holder'],
      ['Tealight Holders', 'candle-stand-tealight-holders', 'holders sized for tealights and votives', 'tealight candle holder'],
      ['Pillar Candle Holders', 'candle-stand-pillar-candle-holders', 'sturdy plates and stands for pillar candles', 'pillar candle'],
      ['Luxury Candle Stands', 'candle-stand-luxury', 'statement candelabras and heirloom stands', 'candelabra'],
    ],
  },
  {
    name: 'Key Holder',
    slug: 'key-holder',
    code: 'KEY',
    description: 'Key holders and entryway organisers so keys, mail and sunglasses always have a home.',
    q: 'entryway key hooks',
    spaces: ['entryway'],
    keywords: ['key', 'keys', 'hook', 'hooks', 'holder', 'wall', 'entryway', 'hallway', 'wooden', 'rack', 'door', 'organizer'],
    children: [
      ['Wooden Key Holders', 'key-holder-wooden', 'solid wood key boards and racks', 'wooden key holder'],
      ['Metal Key Holders', 'key-holder-metal', 'powder-coated and brass key racks', 'metal key hooks'],
      ['Wall Mounted Key Holders', 'key-holder-wall-mounted', 'wall racks with hooks and a shelf for mail', 'wall key rack'],
      ['Decorative Key Holders', 'key-holder-decorative', 'key holders that are also wall art', 'decorative key hooks wall'],
      ['Modern Key Holders', 'key-holder-modern', 'sleek, minimal key organisers', 'modern key holder'],
      ['Handmade Key Holders', 'key-holder-handmade', 'artisan-made holders with character', 'handmade key holder'],
    ],
  },
];

/** "Shop by Space" discovery collections (Collection type `space`), not master categories. */
const SPACES = [
  { name: 'Living Room', slug: 'living-room', q: 'living room interior decor', description: 'Vases, wall art, frames and accents for the room where everyone gathers.' },
  { name: 'Bedroom', slug: 'bedroom', q: 'bedroom interior decor', description: 'Calm, personal pieces for a restful bedroom.' },
  { name: 'Dining Room', slug: 'dining-room', q: 'dining room table decor', description: 'Centrepieces, candle stands and table décor for memorable meals.' },
  { name: 'Kitchen', slug: 'kitchen', q: 'kitchen interior styling', description: 'Organisers, jars and serving pieces for a beautiful working kitchen.' },
  { name: 'Balcony & Garden', slug: 'balcony-garden', q: 'balcony garden plants', description: 'Planters and outdoor accents for balconies, terraces and gardens.' },
  { name: 'Entryway', slug: 'entryway', q: 'entryway hallway decor', description: 'Key holders, mirrors and wall pieces for a welcoming first impression.' },
];

/** Flattened view: parents first (in order), each followed by its children. */
function flattenDecor(taxonomy = DECOR_TAXONOMY) {
  const out = [];
  taxonomy.forEach((p, i) => {
    out.push({ name: p.name, slug: p.slug, parentSlug: null, level: 0, sortOrder: i, description: p.description, code: p.code, keywords: p.keywords, q: p.q, rootSlug: p.slug, rootName: p.name, spaces: p.spaces });
    p.children.forEach(([name, slug, phrase, q], j) => {
      out.push({ name, slug, parentSlug: p.slug, level: 1, sortOrder: j, description: `${name} — ${phrase}.`, code: p.code, keywords: p.keywords, q, rootSlug: p.slug, rootName: p.name, spaces: p.spaces });
    });
  });
  return out;
}

module.exports = { DECOR_TAXONOMY, SPACES, flattenDecor };
