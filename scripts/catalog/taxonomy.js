'use strict';

/**
 * Initial category hierarchy (parent → sub-categories). Slugs are the stable identity used by the
 * catalog seed; names, descriptions and order stay editable in the admin panel afterwards.
 *
 * Deliberate merges (each concept lives in exactly one place):
 *  - Serving bowls and platters live under Serving Essentials, not Dinnerware.
 *  - Tea & coffee gifts live under Tea and Coffee; premium tableware gifts under Premium Crockery Gift Sets.
 *  - Table mats are Placemats (Table Linen); coasters live under Cutlery and Table Accessories.
 *  - Contemporary tableware is covered by Modern Ceramic Collections.
 *  - "Oven-safe" is not used as a category name because no product's oven rating is verified.
 *
 * `code` prefixes SKUs; `keywords` tell the image import what a relevant photo shows.
 */
const TAXONOMY = [
  {
    name: 'Dinnerware',
    slug: 'dinnerware',
    code: 'DIN',
    description: 'Dinner sets, plates and bowls for everyday meals and special occasions.',
    keywords: ['plate', 'plates', 'bowl', 'bowls', 'dish', 'dinnerware', 'tableware', 'ceramic', 'porcelain', 'crockery', 'dinner', 'table setting'],
    children: [
      ['Complete Dinner Sets', 'complete-dinner-sets', 'full table sets with plates, bowls and serving pieces in one design'],
      ['Ceramic Dinner Sets', 'ceramic-dinner-sets', 'glazed ceramic sets with an easy, relaxed character'],
      ['Porcelain Dinner Sets', 'porcelain-dinner-sets', 'fine, bright-white porcelain for crisp table settings'],
      ['Bone China Dinner Sets', 'bone-china-dinner-sets', 'light, translucent bone china for formal dining'],
      ['Stoneware Dinner Sets', 'stoneware-dinner-sets', 'sturdy reactive-glaze stoneware with an artisanal finish'],
      ['Everyday Dinnerware', 'everyday-dinnerware', 'hard-working plates and bowls for daily meals'],
      ['Premium Dinnerware', 'premium-dinnerware', 'statement pieces with metallic accents and refined glazes'],
      ['Side and Quarter Plates', 'side-plates', 'smaller plates for breads, starters and sides'],
      ['Dinner Plates', 'dinner-plates', 'full-size plates for main courses'],
      ['Dessert Plates', 'dessert-plates', 'compact plates for sweets, cakes and fruit'],
      ['Soup Bowls', 'soup-bowls', 'deep bowls for soups, dals and stews'],
      ['Pasta Bowls', 'pasta-bowls', 'wide, shallow bowls for pasta, salads and risotto'],
      ['Cereal Bowls', 'cereal-bowls', 'everyday bowls for breakfast cereal, muesli and fruit'],
    ],
  },
  {
    name: 'Tea and Coffee',
    slug: 'tea-and-coffee',
    code: 'TEA',
    description: 'Tea sets, cups, mugs and pots for the daily chai and the slow weekend brew.',
    keywords: ['tea', 'coffee', 'cup', 'cups', 'mug', 'mugs', 'teapot', 'kettle', 'espresso', 'saucer', 'cappuccino', 'latte', 'pot', 'jug'],
    children: [
      ['Tea Sets', 'tea-sets', 'matching teapots, cups and saucers'],
      ['Premium Tea Sets', 'premium-tea-sets', 'heirloom-style tea services with gold and hand-painted detail'],
      ['Ceramic Tea Sets', 'ceramic-tea-sets', 'glazed ceramic tea sets for everyday tea time'],
      ['Tea Cups and Saucers', 'tea-cups-and-saucers', 'cup-and-saucer pairs for tea and chai'],
      ['Coffee Cups', 'coffee-cups', 'cups sized for filter coffee and americanos'],
      ['Coffee Mugs', 'coffee-mugs', 'generous mugs for coffee, cocoa and tea'],
      ['Espresso Cups', 'espresso-cups', 'small cups for espresso and ristretto'],
      ['Cappuccino Cups', 'cappuccino-cups', 'wide cups that show off milk foam and latte art'],
      ['Teapots', 'teapots', 'pots for brewing loose-leaf and bagged tea'],
      ['Coffee Pots', 'coffee-pots', 'pots and servers for brewed coffee'],
      ['Milk Jugs', 'milk-jugs', 'creamers and jugs for milk and cream'],
      ['Sugar Pots', 'sugar-pots', 'lidded sugar bowls and pots'],
      ['Tea and Coffee Gift Sets', 'tea-and-coffee-gift-sets', 'gift-boxed cups, mugs and pots'],
    ],
  },
  {
    name: 'Glassware',
    slug: 'glassware',
    code: 'GLS',
    description: 'Glasses, carafes and jugs for water, juice, wine and celebrations.',
    keywords: ['glass', 'glasses', 'glassware', 'tumbler', 'wine', 'champagne', 'carafe', 'jug', 'pitcher', 'crystal', 'drink', 'water', 'cocktail', 'bowl'],
    children: [
      ['Drinking Glasses', 'drinking-glasses', 'versatile everyday glasses for any drink'],
      ['Water Glasses', 'water-glasses', 'clear glasses for water at the table'],
      ['Juice Glasses', 'juice-glasses', 'smaller glasses for juice and breakfast drinks'],
      ['Highball Glasses', 'highball-glasses', 'tall glasses for long drinks and mocktails'],
      ['Tumblers', 'tumblers', 'heavy-based tumblers and rocks glasses'],
      ['Crystal Glassware', 'crystal-glassware', 'cut and engraved crystal for special occasions'],
      ['Wine Glasses', 'wine-glasses', 'stemmed glasses for red and white wine'],
      ['Champagne Glasses', 'champagne-glasses', 'flutes and coupes for celebrations'],
      ['Dessert Glasses', 'dessert-glasses', 'glass cups and bowls for desserts and parfaits'],
      ['Glass Jugs', 'glass-jugs', 'jugs and pitchers for water, juice and lemonade'],
      ['Carafes', 'carafes', 'carafes and decanters for water and wine'],
      ['Glass Serving Bowls', 'glass-serving-bowls', 'clear glass bowls for salads, fruit and desserts'],
    ],
  },
  {
    name: 'Serving Essentials',
    slug: 'serving-essentials',
    code: 'SRV',
    description: 'Platters, bowls, trays and stands for serving and entertaining.',
    keywords: ['platter', 'serving', 'tray', 'bowl', 'plate', 'dip', 'cake stand', 'snack', 'salad', 'board', 'food', 'appetizer', 'table'],
    children: [
      ['Serving Platters', 'serving-platters', 'large platters for roasts, biryani and mezze'],
      ['Serving Bowls', 'serving-bowls', 'family-size bowls for curries, salads and sides'],
      ['Serving Trays', 'serving-trays', 'trays for carrying tea, drinks and snacks'],
      ['Snack Plates', 'snack-plates', 'small plates for snacks and appetisers'],
      ['Dip Bowls', 'dip-bowls', 'little bowls for chutneys, dips and sauces'],
      ['Condiment Sets', 'condiment-sets', 'sets for pickles, chutneys and condiments'],
      ['Cake Stands', 'cake-stands', 'pedestal and tiered stands for cakes and pastries'],
      ['Chip and Dip Sets', 'chip-and-dip-sets', 'combined servers for chips and dips'],
      ['Salad Servers', 'salad-servers', 'paired servers for tossing and serving salads'],
      ['Serving Accessories', 'serving-accessories', 'tongs, ladles, cheese knives and other serving helpers'],
    ],
  },
  {
    name: 'Cutlery and Table Accessories',
    slug: 'cutlery-and-table-accessories',
    code: 'CUT',
    description: 'Cutlery sets and the small accessories that finish a table.',
    keywords: ['cutlery', 'fork', 'forks', 'spoon', 'spoons', 'knife', 'knives', 'flatware', 'silverware', 'napkin', 'salt', 'pepper', 'coaster', 'table'],
    children: [
      ['Cutlery Sets', 'cutlery-sets', 'complete sets of spoons, forks and knives'],
      ['Spoon Sets', 'spoon-sets', 'dinner, dessert and tea spoons in sets'],
      ['Fork Sets', 'fork-sets', 'dinner and dessert forks in sets'],
      ['Knife Sets', 'knife-sets', 'table and steak knives for the dining table'],
      ['Serving Spoons', 'serving-spoons', 'large spoons and ladles for serving'],
      ['Stainless Steel Cutlery', 'stainless-steel-cutlery', 'polished and brushed stainless steel cutlery'],
      ['Napkin Holders', 'napkin-holders', 'holders and stands for paper napkins'],
      ['Salt and Pepper Sets', 'salt-and-pepper-sets', 'shakers and grinders for the table'],
      ['Coasters', 'coasters', 'coasters for cups, mugs and glasses'],
      ['Table Accessories', 'table-accessories', 'trivets, bread baskets and other table helpers'],
    ],
  },
  {
    name: 'Kitchen Storage',
    slug: 'kitchen-storage',
    code: 'KST',
    description: 'Jars, canisters and organisers that keep the pantry and counter in order.',
    keywords: ['jar', 'jars', 'storage', 'container', 'canister', 'spice', 'spices', 'pantry', 'kitchen', 'bottle', 'oil', 'shelf', 'organizer', 'counter'],
    children: [
      ['Storage Jars', 'storage-jars', 'lidded jars for grains, pulses and snacks'],
      ['Ceramic Canisters', 'ceramic-canisters', 'glazed canisters for tea, coffee and sugar'],
      ['Glass Storage Containers', 'glass-storage-containers', 'clear glass containers for leftovers and prep'],
      ['Food Storage Containers', 'food-storage-containers', 'containers for storing and carrying food'],
      ['Spice Jars', 'spice-jars', 'small jars for whole and ground spices'],
      ['Spice Racks', 'spice-racks', 'racks and masala boxes that keep spices at hand'],
      ['Oil Dispensers', 'oil-dispensers', 'pourers and dispensers for cooking oil'],
      ['Oil and Vinegar Bottles', 'oil-and-vinegar-bottles', 'paired cruets for oil and vinegar'],
      ['Kitchen Organizers', 'kitchen-organizers', 'holders and caddies for utensils and tools'],
      ['Countertop Storage', 'countertop-storage', 'bread bins, fruit baskets and counter canisters'],
    ],
  },
  {
    name: 'Bakeware and Ovenware',
    slug: 'bakeware-and-ovenware',
    code: 'BAK',
    description: 'Baking dishes, ramekins and mixing bowls for the home baker. Check each product for its heat rating.',
    keywords: ['baking', 'bake', 'dish', 'casserole', 'pie', 'ramekin', 'souffle', 'mixing bowl', 'oven', 'gratin', 'tart', 'kitchen', 'cake'],
    children: [
      ['Baking Dishes', 'baking-dishes', 'rectangular and oval dishes for bakes and gratins'],
      ['Casserole Dishes', 'casserole-dishes', 'lidded dishes for slow-cooked dishes and serving'],
      ['Oven-to-Table Dishes', 'oven-to-table-dishes', 'baking dishes designed to be brought straight to the table'],
      ['Pie Dishes', 'pie-dishes', 'round dishes with fluted edges for pies and tarts'],
      ['Ramekins', 'ramekins', 'individual pots for crème brûlée, dips and puddings'],
      ['Soufflé Dishes', 'souffle-dishes', 'straight-sided dishes for soufflés and bakes'],
      ['Mixing Bowls', 'mixing-bowls', 'nesting bowls for mixing, whisking and proving'],
      ['Baking Accessories', 'baking-accessories', 'pie weights, pastry brushes and baking helpers'],
    ],
  },
  {
    name: 'Decorative Homeware',
    slug: 'decorative-homeware',
    code: 'DEC',
    description: 'Vases, bowls, centrepieces and candle holders to dress the home.',
    keywords: ['vase', 'vases', 'decor', 'decorative', 'ceramic', 'sculpture', 'candle', 'centerpiece', 'bowl', 'plate', 'interior', 'flowers', 'pottery'],
    children: [
      ['Decorative Vases', 'decorative-vases', 'vases for fresh, dried and faux flowers'],
      ['Ceramic Vases', 'ceramic-vases', 'glazed and matte ceramic vases'],
      ['Sculptural Vases', 'sculptural-vases', 'vases with organic and architectural forms'],
      ['Decorative Bowls', 'decorative-bowls', 'display bowls for consoles and coffee tables'],
      ['Table Centerpieces', 'table-centerpieces', 'statement pieces for the centre of the table'],
      ['Ceramic Showpieces', 'ceramic-showpieces', 'ceramic figures and objects for shelves'],
      ['Decorative Plates', 'decorative-plates', 'wall and display plates'],
      ['Candle Holders', 'candle-holders', 'holders for tea lights, pillars and tapers'],
      ['Decorative Accessories', 'decorative-accessories', 'trinket trays, boxes and finishing touches'],
    ],
  },
  {
    name: 'Gift Collections',
    slug: 'gift-collections',
    code: 'GFT',
    description: 'Gift-ready tableware for weddings, housewarmings, festivals and corporate gifting.',
    keywords: ['gift', 'gifts', 'box', 'present', 'set', 'wrapped', 'tableware', 'cups', 'plates', 'glasses', 'festive', 'celebration'],
    children: [
      ['Premium Crockery Gift Sets', 'premium-crockery-gift-sets', 'luxury dinnerware and tableware sets in gift packaging'],
      ['Wedding Gift Sets', 'wedding-gift-sets', 'tableware sets chosen for newlyweds'],
      ['Housewarming Gifts', 'housewarming-gifts', 'useful, beautiful gifts for a new home'],
      ['Anniversary Gifts', 'anniversary-gifts', 'paired pieces for celebrating together'],
      ['Festive Gift Sets', 'festive-gift-sets', 'gift sets for Diwali, Eid, Christmas and other festivals'],
      ['Corporate Gift Sets', 'corporate-gift-sets', 'understated sets for clients and teams'],
    ],
  },
  {
    name: 'Table Linen',
    slug: 'table-linen',
    code: 'LIN',
    description: 'Tablecloths, runners, napkins and placemats in cotton and linen.',
    keywords: ['tablecloth', 'table runner', 'napkin', 'napkins', 'placemat', 'placemats', 'linen', 'cotton', 'fabric', 'table', 'textile', 'dining'],
    children: [
      ['Tablecloths', 'tablecloths', 'cloths for everyday and festive tables'],
      ['Table Runners', 'table-runners', 'runners that add colour down the length of the table'],
      ['Cloth Napkins', 'cloth-napkins', 'reusable cotton and linen napkins'],
      ['Placemats', 'placemats', 'woven, fabric and cork placemats'],
      ['Napkin Rings', 'napkin-rings', 'rings that finish a folded napkin'],
    ],
  },
  {
    name: 'Specialty Collections',
    slug: 'specialty-collections',
    code: 'SPC',
    description: 'Curated tableware edits by style — minimalist, floral, traditional and luxe.',
    keywords: ['tableware', 'plates', 'bowls', 'ceramic', 'dinnerware', 'table setting', 'cups', 'dish', 'minimal', 'floral', 'pottery', 'dining'],
    children: [
      ['Minimalist Tableware', 'minimalist-tableware', 'clean lines and quiet, neutral glazes'],
      ['Modern Ceramic Collections', 'modern-ceramic-collections', 'contemporary shapes and studio glazes'],
      ['Floral Crockery', 'floral-crockery', 'botanical patterns and painted florals'],
      ['Traditional Indian Tableware', 'traditional-indian-tableware', 'thalis, katoris and tumblers in classic forms'],
      ['Luxury Dining Collections', 'luxury-dining-collections', 'gold-accented pieces for grand dinners'],
      ['Everyday Dining Essentials', 'everyday-dining-essentials', 'versatile basics that mix and match'],
      ['Premium Homeware Collections', 'premium-homeware-collections', 'coordinated serveware and decor edits'],
    ],
  },
  {
    name: "Children's Tableware",
    slug: 'childrens-tableware',
    code: 'KID',
    description: 'Playful plates, bowls and cups sized for smaller hands.',
    keywords: ['kids', 'children', 'child', 'baby', 'plate', 'bowl', 'cup', 'colorful', 'toddler', 'tableware', 'mug', 'animal'],
    children: [
      ["Children's Plates", 'childrens-plates', 'divided and picture plates for children'],
      ["Children's Bowls", 'childrens-bowls', 'easy-grip bowls for children'],
      ["Children's Cups", 'childrens-cups', 'cups and tumblers sized for children'],
      ["Children's Dining Sets", 'childrens-dining-sets', 'matching plate, bowl and cup sets for children'],
    ],
  },
];

/** Flattened view: parents first (in order), each followed by its children. */
function flatten(taxonomy = TAXONOMY) {
  const out = [];
  taxonomy.forEach((p, i) => {
    out.push({ name: p.name, slug: p.slug, parentSlug: null, level: 0, sortOrder: i, description: p.description, code: p.code, keywords: p.keywords, rootSlug: p.slug });
    p.children.forEach(([name, slug, phrase], j) => {
      out.push({ name, slug, parentSlug: p.slug, level: 1, sortOrder: j, description: `${name} — ${phrase}.`, code: p.code, keywords: p.keywords, rootSlug: p.slug });
    });
  });
  return out;
}

module.exports = { TAXONOMY, flatten };
