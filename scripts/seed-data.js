'use strict';

/**
 * Starter catalog. Categories are editable in the admin panel — these are initial examples, not
 * hard-coded business rules. Prices are paise. Safety attributes are only set where they would be
 * verified with the supplier; anything unverified is left null and is never shown to customers.
 */

const CATEGORY_TREE = [
  {
    name: 'Crockery & Dinnerware',
    slug: 'crockery-dinnerware',
    children: ['Dinner Sets', 'Ceramic Dinner Sets', 'Bone China Dinner Sets', 'Porcelain Crockery', 'Stoneware Crockery', 'Plates & Side Plates', 'Bowls & Soup Bowls', 'Cups & Saucers', 'Mugs', 'Serving Platters', 'Serving Bowls', 'Casseroles', 'Thalis & Traditional Tableware'],
  },
  {
    name: 'Glassware',
    slug: 'glassware',
    children: ['Water Glasses', 'Drinking Glass Sets', 'Whiskey Glasses', 'Juice Glasses', 'Wine Glasses', 'Glass Jugs & Pitchers', 'Glass Tumblers', 'Dessert Glasses', 'Glass Storage Jars', 'Borosilicate Glassware', 'Crystal-Style Decorative Glassware'],
  },
  {
    name: 'Kitchenware',
    slug: 'kitchenware',
    children: ['Storage Containers', 'Airtight Jars', 'Mixing Bowls', 'Measuring Cups', 'Kitchen Organizers', 'Serving Trays', 'Cutlery', 'Spoons & Forks', 'Kitchen Accessories'],
  },
  {
    name: 'Tableware',
    slug: 'tableware',
    children: ['Table Accessories', 'Placemats & Coasters', 'Napkin Holders', 'Table Runners', 'Table Centerpieces', 'Serving Accessories'],
  },
  {
    name: 'Home Decor',
    slug: 'home-decor',
    children: ['Decorative Vases', 'Ceramic Showpieces', 'Decorative Bowls', 'Candle Holders', 'Table Decor', 'Decorative Trays', 'Artificial Floral Arrangements', 'Wall Decor', 'Gift Sets', 'Festive Decor'],
  },
];

// Demo photography from Unsplash (https://unsplash.com/license), matched to each demo product so the
// storefront never shows unrelated images. Replace with real product photos via the admin media API.
const UNSPLASH = {
  'ivory-ceramic-dinner-set-24-pieces': ['1630527152680-500b5453fb04', '1522413452208-996ff3f3e740'],
  'gold-rim-bone-china-dinner-set-33-pieces': ['1612634092588-f2f648b72cbd'],
  'handmade-stoneware-dinner-plates-set-of-4': ['1572003414130-d1b4632a0d73', '1587560555570-4d3f84dcee05'],
  'matte-ceramic-coffee-mug-350-ml': ['1518358246973-95637f1df901', '1590422749897-47036da0b0ff'],
  'borosilicate-water-glass-set-of-6-300-ml': ['1610821165540-80c084d50fd3', '1608322368442-2db3b4090724'],
  'crystal-cut-whiskey-glasses-set-of-2': ['1788106702702-a0220e0f439f', '1583873463426-776e17c904cf'],
  'glass-jug-with-lid-1-3-l': ['1620877138710-e086a5f24b46'],
  'airtight-glass-storage-jars-set-of-3': ['1567966221845-e91f7d888354'],
  'stainless-steel-cutlery-set-24-pieces': ['1619367300924-485907ff690d', '1658206805853-badb9282212a'],
  'woven-bamboo-placemats-set-of-6': ['1791432372127-ed6f50c00e0c'],
  'hand-painted-ceramic-vase-30-cm': ['1526198049595-f32cde2a219d'],
  'brass-diya-candle-holders-set-of-4': ['1760630004439-18b3bbd826be'],
  'housewarming-gift-box-dinner-set-glass-set': ['1727257050264-33a4f5f0982a', '1522413452208-996ff3f3e740'],
};
const unsplash = (id, w) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=${w}&h=${w}&q=80`;
const img = (seed) =>
  UNSPLASH[seed]
    ? UNSPLASH[seed].map((id, i) => ({ url: unsplash(id, 1400), mediumUrl: unsplash(id, 700), thumbUrl: unsplash(id, 300), alt: seed.replace(/-/g, ' '), sortOrder: i }))
    : [{ url: `https://picsum.photos/seed/${seed}/1200/1200`, thumbUrl: `https://picsum.photos/seed/${seed}/300/300`, alt: seed.replace(/-/g, ' ') }];

const PRODUCTS = [
  {
    category: 'ceramic-dinner-sets',
    name: 'Ivory Ceramic Dinner Set — 24 Pieces',
    brand: 'Clay Craft',
    description: 'Classic ivory ceramic dinner set for six: 6 dinner plates, 6 quarter plates, 6 katoris and 6 soup bowls.',
    highlights: ['Serves 6', '24 pieces', 'Glossy ivory glaze'],
    variants: [{ sku: 'CC-DS24-IVORY', mrp: 449900, price: 299900, costPrice: 170000, weightGrams: 7200, dimensions: { lengthMm: 420, widthMm: 330, heightMm: 300 } }],
    specs: { material: 'ceramic', piecesPerSet: 24, serves: 6, color: 'ivory', finish: 'glossy', setComposition: [{ item: 'dinner plate', count: 6 }, { item: 'quarter plate', count: 6 }, { item: 'katori', count: 6 }, { item: 'soup bowl', count: 6 }] },
    care: { microwaveSafe: true, dishwasherSafe: true },
    tax: { hsnCode: '6912', gstRateBps: 1200 },
    packaging: { requirements: ['multi_layer_box', 'foam_inserts'] },
    flags: { bestseller: true },
    giftWrapAvailable: true,
    stock: 40,
  },
  {
    category: 'bone-china-dinner-sets',
    name: 'Gold Rim Bone China Dinner Set — 33 Pieces',
    brand: 'Royal Heritage',
    description: 'Fine bone china with a hand-applied gold rim. Not microwave safe because of the metallic rim.',
    variants: [{ sku: 'RH-BC33-GOLD', mrp: 1299900, price: 999900, costPrice: 620000, weightGrams: 9800, dimensions: { lengthMm: 480, widthMm: 380, heightMm: 340 } }],
    specs: { material: 'bone_china', piecesPerSet: 33, serves: 6, color: 'white', pattern: 'gold rim', setComposition: [{ item: 'dinner plate', count: 6 }, { item: 'quarter plate', count: 6 }, { item: 'bowl', count: 12 }, { item: 'serving bowl', count: 3 }, { item: 'platter', count: 1 }, { item: 'spoon rest', count: 5 }] },
    care: { microwaveSafe: false, dishwasherSafe: false, foodSafe: true },
    tax: { hsnCode: '6911', gstRateBps: 1200 },
    packaging: { requirements: ['large_set_crate', 'foam_inserts'], notes: 'Wrap gold-rim pieces individually' },
    flags: { featured: true },
    giftWrapAvailable: true,
    stock: 8,
  },
  {
    category: 'stoneware-crockery',
    name: 'Handmade Stoneware Dinner Plates — Set of 4',
    brand: 'Earth Kiln',
    variants: [
      { sku: 'EK-SW-PL4-TEAL', title: 'Teal', attributes: { color: 'teal', setSize: 4 }, mrp: 239900, price: 189900, weightGrams: 3600 },
      { sku: 'EK-SW-PL4-SAND', title: 'Sand', attributes: { color: 'beige', setSize: 4 }, mrp: 239900, price: 189900, weightGrams: 3600 },
    ],
    specs: { material: 'stoneware', piecesPerSet: 4, finish: 'reactive glaze' },
    care: { microwaveSafe: true, dishwasherSafe: true, ovenSafe: true },
    tax: { hsnCode: '6912', gstRateBps: 1200 },
    flags: { newArrival: true },
    stock: 25,
  },
  {
    category: 'mugs',
    name: 'Matte Ceramic Coffee Mug 350 ml',
    brand: 'Clay Craft',
    variants: [
      { sku: 'CC-MUG350-BLK', title: 'Black', attributes: { color: 'black', capacityMl: 350 }, mrp: 49900, price: 34900, weightGrams: 420 },
      { sku: 'CC-MUG350-WHT', title: 'White', attributes: { color: 'white', capacityMl: 350 }, mrp: 49900, price: 34900, weightGrams: 420 },
    ],
    specs: { material: 'ceramic', capacityMl: 350 },
    care: { microwaveSafe: true, dishwasherSafe: true },
    tax: { hsnCode: '6912', gstRateBps: 1200 },
    stock: 120,
  },
  {
    category: 'drinking-glass-sets',
    name: 'Borosilicate Water Glass Set of 6 — 300 ml',
    brand: 'Borosil',
    variants: [{ sku: 'BS-WG6-300', mrp: 129900, price: 94900, costPrice: 52000, weightGrams: 1700, attributes: { capacityMl: 300, setSize: 6 } }],
    specs: { material: 'borosilicate_glass', capacityMl: 300, piecesPerSet: 6 },
    care: { microwaveSafe: true, dishwasherSafe: true },
    tax: { hsnCode: '7013', gstRateBps: 1800 },
    packaging: { requirements: ['separate_glass_packing'] },
    flags: { bestseller: true },
    stock: 80,
  },
  {
    category: 'whiskey-glasses',
    name: 'Crystal-Cut Whiskey Glasses — Set of 2',
    brand: 'Ocean',
    variants: [{ sku: 'OC-WHISKY-2', mrp: 159900, price: 119900, weightGrams: 900, attributes: { capacityMl: 290, setSize: 2 } }],
    specs: { material: 'crystal_glass', capacityMl: 290, piecesPerSet: 2, design: 'diamond cut' },
    care: { dishwasherSafe: false },
    tax: { hsnCode: '7013', gstRateBps: 1800 },
    giftWrapAvailable: true,
    stock: 30,
  },
  {
    category: 'glass-jugs-pitchers',
    name: 'Glass Jug with Lid 1.3 L',
    brand: 'Borosil',
    variants: [{ sku: 'BS-JUG-1300', mrp: 89900, price: 69900, weightGrams: 950, attributes: { capacityMl: 1300 } }],
    specs: { material: 'glass', capacityMl: 1300 },
    tax: { hsnCode: '7013', gstRateBps: 1800 },
    stock: 45,
  },
  {
    category: 'glass-storage-jars',
    name: 'Airtight Glass Storage Jars — Set of 3',
    brand: 'Treo',
    variants: [{ sku: 'TR-JAR3-AIR', mrp: 119900, price: 79900, weightGrams: 2100 }],
    specs: { material: 'glass', piecesPerSet: 3 },
    tax: { hsnCode: '7013', gstRateBps: 1800 },
    stock: 60,
  },
  {
    category: 'cutlery',
    name: 'Stainless Steel Cutlery Set — 24 Pieces',
    brand: 'Steelcraft',
    isFragile: false,
    variants: [{ sku: 'SC-CUT24-SS', mrp: 249900, price: 169900, weightGrams: 1600 }],
    specs: { material: 'stainless_steel', piecesPerSet: 24, finish: 'mirror' },
    care: { dishwasherSafe: true },
    tax: { hsnCode: '8215', gstRateBps: 1800 },
    stock: 50,
  },
  {
    category: 'placemats-coasters',
    name: 'Woven Bamboo Placemats — Set of 6',
    brand: 'Tablecraft',
    isFragile: false,
    variants: [{ sku: 'TC-PM6-BAMBOO', mrp: 99900, price: 64900, weightGrams: 800 }],
    specs: { material: 'bamboo', piecesPerSet: 6 },
    tax: { hsnCode: '4602', gstRateBps: 1200 },
    stock: 70,
  },
  {
    category: 'decorative-vases',
    name: 'Hand-Painted Ceramic Vase — 30 cm',
    brand: 'Earth Kiln',
    variants: [{ sku: 'EK-VASE30-BLUE', mrp: 189900, price: 149900, weightGrams: 1400, dimensions: { heightMm: 300, diameterMm: 140 } }],
    specs: { material: 'ceramic', pattern: 'floral', color: 'blue' },
    tax: { hsnCode: '6913', gstRateBps: 1200 },
    giftWrapAvailable: true,
    stock: 15,
  },
  {
    category: 'candle-holders',
    name: 'Brass Diya Candle Holders — Set of 4',
    brand: 'Festive Lights',
    isFragile: false,
    variants: [{ sku: 'FL-DIYA4-BRASS', mrp: 129900, price: 89900, weightGrams: 700 }],
    specs: { material: 'brass', piecesPerSet: 4 },
    tax: { hsnCode: '7418', gstRateBps: 1200 },
    flags: { featured: true },
    giftWrapAvailable: true,
    stock: 90,
  },
];

const BUNDLES = [
  {
    category: 'gift-sets',
    name: 'Housewarming Gift Box — Dinner Set + Glass Set',
    description: 'Our ivory 24-piece dinner set with six borosilicate water glasses, gift-wrapped.',
    variants: [{ sku: 'GIFT-HOUSEWARMING', mrp: 579800, price: 379900 }],
    bundleItems: [
      { sku: 'CC-DS24-IVORY', quantity: 1 },
      { sku: 'BS-WG6-300', quantity: 1 },
    ],
    giftWrapAvailable: true,
    flags: { featured: true },
  },
];

const COLLECTIONS = [
  { name: 'Wedding Gifting', slug: 'wedding-gifting', type: 'gift', skus: ['RH-BC33-GOLD', 'GIFT-HOUSEWARMING', 'OC-WHISKY-2'] },
  { name: 'Festive Glassware', slug: 'festive-glassware', type: 'festival', skus: ['OC-WHISKY-2', 'BS-WG6-300', 'BS-JUG-1300'] },
  { name: 'Housewarming Essentials', slug: 'housewarming-essentials', type: 'gift', skus: ['GIFT-HOUSEWARMING', 'TR-JAR3-AIR', 'SC-CUT24-SS', 'TC-PM6-BAMBOO'] },
];

module.exports = { CATEGORY_TREE, PRODUCTS, BUNDLES, COLLECTIONS, img };
