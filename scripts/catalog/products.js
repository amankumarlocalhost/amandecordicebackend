'use strict';

/**
 * Initial catalog: exactly two distinct products per category slug (parents included — products may
 * be assigned directly to a parent category). Prices are whole rupees here and converted to paise
 * by the seed. Safety/heat/food-contact attributes are intentionally absent (unknown until verified
 * with the supplier). `q` is the Unsplash search query for the product's representative photo.
 *
 * Fields: n name · m material · c colour · f finish · ds design · pcs pieces per set · comp set
 * composition · dim dimensions (mm) · ml capacity · sv serves · mrp / p price (₹) · b description · q
 */

const D = (diameterMm, heightMm) => (heightMm ? { diameterMm, heightMm } : { diameterMm });
const L = (lengthMm, widthMm, heightMm) => (heightMm ? { lengthMm, widthMm, heightMm } : { lengthMm, widthMm });

const PRODUCTS = {
  // ------------------------------------------------------------------ Dinnerware
  dinnerware: [
    { n: 'Aranya Reactive Glaze Dinnerware Collection', m: 'stoneware', c: 'forest green', f: 'reactive glaze', pcs: 16, comp: [['Dinner plate', 4], ['Quarter plate', 4], ['Bowl', 4], ['Mug', 4]], sv: 4, mrp: 7499, p: 5999, b: 'A sixteen-piece stoneware collection in a deep forest-green reactive glaze that pools darker at the rims, so no two pieces look quite the same.', q: 'green stoneware plates bowls' },
    { n: 'Kaveri Classic White Dinnerware Starter Set', m: 'porcelain', c: 'white', f: 'gloss', pcs: 12, comp: [['Dinner plate', 4], ['Side plate', 4], ['Bowl', 4]], sv: 4, mrp: 3999, p: 3299, b: 'Clean, rimless white porcelain in three essential shapes — a quiet foundation that works with any table linen or serveware.', q: 'white porcelain dinnerware set' },
  ],
  'complete-dinner-sets': [
    { n: 'Heritage Gold Rim Complete Dinner Set — 40 Pieces', m: 'porcelain', c: 'white', f: 'gloss', ds: 'gold rim', pcs: 40, comp: [['Dinner plate', 6], ['Quarter plate', 6], ['Soup bowl', 6], ['Katori', 6], ['Serving bowl', 2], ['Serving platter', 1], ['Rice plate', 1], ['Cup', 6], ['Saucer', 6]], sv: 6, mrp: 18999, p: 14999, b: 'A complete service for six with a fine gold line at every rim, including serving bowls, a platter and katoris for Indian meals.', q: 'gold rim white dinner set' },
    { n: 'Nordic Speckle Complete Dinner Set — 32 Pieces', m: 'stoneware', c: 'oat', f: 'speckled matte', pcs: 32, comp: [['Dinner plate', 6], ['Side plate', 6], ['Pasta bowl', 6], ['Cereal bowl', 6], ['Mug', 6], ['Serving bowl', 1], ['Serving platter', 1]], sv: 6, mrp: 15999, p: 12499, b: 'Oat-coloured stoneware flecked with iron speckles — a relaxed Scandinavian-style set that covers breakfast to dinner for six.', q: 'speckled stoneware dinnerware' },
  ],
  'ceramic-dinner-sets': [
    { n: 'Terracotta Sunset Ceramic Dinner Set — 18 Pieces', m: 'ceramic', c: 'terracotta', f: 'satin glaze', pcs: 18, comp: [['Dinner plate', 6], ['Quarter plate', 6], ['Bowl', 6]], sv: 6, mrp: 6999, p: 5499, b: 'Warm terracotta tones with a satin glaze and an exposed clay foot ring, for a sun-baked Mediterranean feel.', q: 'terracotta ceramic plates' },
    { n: 'Indigo Brushstroke Ceramic Dinner Set — 24 Pieces', m: 'ceramic', c: 'indigo', f: 'gloss', ds: 'hand-brushed rim', pcs: 24, comp: [['Dinner plate', 6], ['Quarter plate', 6], ['Bowl', 6], ['Katori', 6]], sv: 6, mrp: 8499, p: 6799, b: 'Each piece carries a loose indigo brushstroke around the rim, applied by hand so the band varies gently from plate to plate.', q: 'blue ceramic dinner plates' },
  ],
  'porcelain-dinner-sets': [
    { n: 'Lumière Embossed Porcelain Dinner Set — 30 Pieces', m: 'porcelain', c: 'white', f: 'gloss', ds: 'embossed dot border', pcs: 30, comp: [['Dinner plate', 6], ['Side plate', 6], ['Soup bowl', 6], ['Cup', 6], ['Saucer', 6]], sv: 6, mrp: 12999, p: 9999, b: 'Bright white porcelain with a raised dot border that catches the light — tone-on-tone detail for formal and everyday tables alike.', q: 'embossed white porcelain plates' },
    { n: 'Coupe Line Porcelain Dinner Set — 18 Pieces', m: 'porcelain', c: 'white', f: 'gloss', ds: 'rimless coupe', pcs: 18, comp: [['Dinner plate', 6], ['Dessert plate', 6], ['Bowl', 6]], sv: 6, mrp: 7999, p: 6499, b: 'Rimless coupe shapes in thin, bright porcelain — a restaurant-style set that lets the food take centre stage.', q: 'white coupe porcelain plate' },
  ],
  'bone-china-dinner-sets': [
    { n: 'Windsor Platinum Band Bone China Dinner Set — 33 Pieces', m: 'bone_china', c: 'white', f: 'gloss', ds: 'platinum band', pcs: 33, comp: [['Dinner plate', 6], ['Quarter plate', 6], ['Soup bowl', 6], ['Katori', 6], ['Serving bowl', 2], ['Serving platter', 1], ['Dessert plate', 6]], sv: 6, mrp: 21999, p: 17499, b: 'Fine bone china with a cool platinum band, light in the hand and translucent against the light — made for formal dinners.', q: 'fine bone china dinner set' },
    { n: 'Rosewood Floral Bone China Dinner Set — 27 Pieces', m: 'bone_china', c: 'ivory', f: 'gloss', pa: 'floral', ds: 'rose spray', pcs: 27, comp: [['Dinner plate', 6], ['Quarter plate', 6], ['Bowl', 6], ['Katori', 6], ['Serving bowl', 2], ['Serving platter', 1]], sv: 6, mrp: 18499, p: 14999, b: 'Ivory bone china decorated with delicate sprays of dusky roses — a romantic set that suits festive and family occasions.', q: 'floral bone china plates' },
  ],
  'stoneware-dinner-sets': [
    { n: 'Basalt Matte Stoneware Dinner Set — 16 Pieces', m: 'stoneware', c: 'charcoal', f: 'matte', pcs: 16, comp: [['Dinner plate', 4], ['Side plate', 4], ['Bowl', 4], ['Mug', 4]], sv: 4, mrp: 6999, p: 5599, b: 'Charcoal stoneware with a soft, stony matte surface — dramatic with bright food and natural linen.', q: 'black matte stoneware plates' },
    { n: 'Ocean Drift Stoneware Dinner Set — 12 Pieces', m: 'stoneware', c: 'sea blue', f: 'reactive glaze', pcs: 12, comp: [['Dinner plate', 4], ['Side plate', 4], ['Bowl', 4]], sv: 4, mrp: 5499, p: 4399, b: 'A sea-blue reactive glaze breaks to sandy brown at the edges, like surf meeting shore.', q: 'blue reactive glaze stoneware' },
  ],
  'everyday-dinnerware': [
    { n: 'Daily Table Plate and Bowl Set — 8 Pieces', m: 'ceramic', c: 'white', f: 'gloss', pcs: 8, comp: [['Dinner plate', 4], ['Bowl', 4]], sv: 4, mrp: 1999, p: 1599, b: 'A no-fuss set of four plates and four bowls in glossy white ceramic — the pieces you reach for every single day.', q: 'simple white plates bowls stack' },
    { n: 'Sage Everyday Dinnerware Set — 12 Pieces', m: 'stoneware', c: 'sage', f: 'satin', pcs: 12, comp: [['Dinner plate', 4], ['Quarter plate', 4], ['Bowl', 4]], sv: 4, mrp: 3499, p: 2799, b: 'Soft sage stoneware with a satin finish — calm, versatile and easy to pair with colourful food.', q: 'sage green ceramic plates' },
  ],
  'premium-dinnerware': [
    { n: 'Maharani Gold Lace Dinner Plate Set of 6', m: 'bone_china', c: 'white', f: 'gloss', ds: 'gold lace border', pcs: 6, dim: D(270), mrp: 8999, p: 7499, b: 'An intricate gold lace border frames each fine bone china plate — a statement for celebrations and formal dining.', q: 'gold pattern luxury plate' },
    { n: 'Obsidian Gold Edge Dinner Set — 18 Pieces', m: 'porcelain', c: 'black', f: 'matte', ds: 'gold edge', pcs: 18, comp: [['Dinner plate', 6], ['Side plate', 6], ['Bowl', 6]], sv: 6, mrp: 13999, p: 11499, b: 'Matte black porcelain finished with a thin gold edge for evening dinners with candlelight.', q: 'black and gold plates table' },
  ],
  'side-plates': [
    { n: 'Linen Texture Side Plates Set of 6', m: 'porcelain', c: 'white', f: 'gloss', ds: 'linen texture', pcs: 6, dim: D(200), mrp: 1799, p: 1499, b: 'A subtle woven-linen texture pressed into white porcelain gives these 20 cm side plates quiet interest.', q: 'small white side plates' },
    { n: 'Clay Rim Quarter Plates Set of 4', m: 'stoneware', c: 'cream', f: 'matte', ds: 'exposed clay rim', pcs: 4, dim: D(190), mrp: 1499, p: 1199, b: 'Cream glaze with a raw clay rim — handy 19 cm quarter plates for breads, snacks and sides.', q: 'cream stoneware small plates' },
  ],
  'dinner-plates': [
    { n: 'Sandstone Matte Dinner Plates Set of 4', m: 'stoneware', c: 'sand', f: 'matte', pcs: 4, dim: D(270), mrp: 2499, p: 1999, b: 'Full-size 27 cm stoneware dinner plates in a sandy matte glaze with a softly raised rim.', q: 'beige matte dinner plate' },
    { n: 'Glacier Wide Rim Dinner Plates Set of 6', m: 'porcelain', c: 'white', f: 'gloss', ds: 'wide rim', pcs: 6, dim: D(285), mrp: 2999, p: 2499, b: 'Generous 28.5 cm plates with a wide rim that frames the food like a gallery mount.', q: 'wide rim white dinner plate' },
  ],
  'dessert-plates': [
    { n: 'Petal Edge Dessert Plates Set of 6', m: 'porcelain', c: 'blush pink', f: 'gloss', ds: 'scalloped petal edge', pcs: 6, dim: D(180), mrp: 1999, p: 1599, b: 'Scalloped, petal-shaped edges in blush porcelain — pretty plates for cakes, mithai and fruit.', q: 'pink dessert plate cake' },
    { n: 'Gilded Dot Dessert Plates Set of 4', m: 'bone_china', c: 'white', f: 'gloss', ds: 'gold dots', pcs: 4, dim: D(200), mrp: 2499, p: 1999, b: 'Scattered gold dots on fine bone china make these dessert plates feel celebratory without being fussy.', q: 'dessert plate gold dots' },
  ],
  'soup-bowls': [
    { n: 'Hearth Handled Soup Bowls Set of 4', m: 'stoneware', c: 'rust', f: 'reactive glaze', pcs: 4, ml: 450, dim: D(140, 75), mrp: 1999, p: 1599, b: 'Deep 450 ml bowls with small side handles, glazed in a warm rust that recalls a wood-fired hearth.', q: 'soup bowl handles ceramic' },
    { n: 'Cloud White Soup Bowls Set of 6', m: 'porcelain', c: 'white', f: 'gloss', pcs: 6, ml: 400, dim: D(150, 65), mrp: 1799, p: 1499, b: 'Simple, rounded 400 ml porcelain bowls for soups, dals and noodles.', q: 'white soup bowl' },
  ],
  'pasta-bowls': [
    { n: 'Trattoria Wide Pasta Bowls Set of 4', m: 'stoneware', c: 'ivory', f: 'satin', ds: 'brown rim', pcs: 4, dim: D(230, 45), mrp: 2499, p: 1999, b: 'Shallow 23 cm bowls with a brown-dipped rim — wide enough for pasta, risotto and grain salads.', q: 'pasta bowl stoneware' },
    { n: 'Azure Glaze Pasta Bowls Set of 2', m: 'ceramic', c: 'azure', f: 'gloss', pcs: 2, dim: D(220, 50), mrp: 1299, p: 1049, b: 'A pair of bright azure pasta bowls that bring a touch of the Amalfi coast to weeknight dinners.', q: 'blue pasta bowl' },
  ],
  'cereal-bowls': [
    { n: 'Morning Ritual Cereal Bowls Set of 4', m: 'stoneware', c: 'mustard', f: 'satin', pcs: 4, ml: 600, dim: D(155, 70), mrp: 1599, p: 1299, b: 'Cheerful mustard bowls sized at 600 ml for cereal, muesli, oats and fruit.', q: 'breakfast cereal bowl' },
    { n: 'Two-Tone Dipped Cereal Bowls Set of 6', m: 'ceramic', c: 'white and grey', f: 'gloss and matte', ds: 'two-tone dip', pcs: 6, ml: 550, dim: D(150, 68), mrp: 1999, p: 1599, b: 'Half-dipped in glossy white over a matte grey body — a modern everyday bowl.', q: 'two tone ceramic bowl' },
  ],

  // ------------------------------------------------------------------ Tea and Coffee
  'tea-and-coffee': [
    { n: 'Chai Time Essentials Set — 6 Cups and Kettle Tray', m: 'ceramic', c: 'cream', f: 'gloss', pcs: 7, comp: [['Chai cup', 6], ['Serving tray', 1]], mrp: 2999, p: 2399, b: 'Six chai-sized cups and a matching tray in cream glaze, ready for afternoon tea with family and guests.', q: 'chai cups tray' },
    { n: 'Brew Bar Coffee and Tea Starter Set', m: 'stoneware', c: 'charcoal', f: 'matte', pcs: 5, comp: [['Mug', 4], ['Pour jug', 1]], mrp: 2799, p: 2299, b: 'Four charcoal mugs and a small pouring jug — a compact set for coffee lovers and tea drinkers sharing one counter.', q: 'coffee mugs set table' },
  ],
  'tea-sets': [
    { n: 'Darjeeling Garden Tea Set — 15 Pieces', m: 'porcelain', c: 'white', f: 'gloss', pa: 'floral', ds: 'tea leaf print', pcs: 15, comp: [['Teapot', 1], ['Cup', 6], ['Saucer', 6], ['Sugar pot', 1], ['Milk jug', 1]], sv: 6, mrp: 5999, p: 4799, b: 'A full tea service printed with fine green tea-leaf sprigs, from teapot to milk jug.', q: 'porcelain tea set teapot cups' },
    { n: 'Monsoon Grey Tea Set — 9 Pieces', m: 'stoneware', c: 'grey', f: 'matte', pcs: 9, comp: [['Teapot', 1], ['Cup', 4], ['Saucer', 4]], sv: 4, mrp: 3999, p: 3299, b: 'Rain-cloud grey stoneware in soft, rounded shapes for slow monsoon afternoons.', q: 'grey ceramic tea set' },
  ],
  'premium-tea-sets': [
    { n: 'Royal Peacock Gold Tea Set — 17 Pieces', m: 'bone_china', c: 'teal', f: 'gloss', ds: 'peacock motif with gold', pcs: 17, comp: [['Teapot', 1], ['Cup', 6], ['Saucer', 6], ['Sugar pot', 1], ['Milk jug', 1], ['Cake plate', 2]], sv: 6, mrp: 14999, p: 12499, b: 'Fine bone china painted with peacock feathers and highlighted in gold — an heirloom-style tea service.', q: 'luxury gold tea set' },
    { n: 'Victoria Fluted Tea Set — 15 Pieces', m: 'bone_china', c: 'white', f: 'gloss', ds: 'fluted with gold trim', pcs: 15, comp: [['Teapot', 1], ['Cup', 6], ['Saucer', 6], ['Sugar pot', 1], ['Milk jug', 1]], sv: 6, mrp: 11999, p: 9999, b: 'Vertical flutes and a gold trim give this bone china tea set a classic, Victorian silhouette.', q: 'vintage white tea set gold' },
  ],
  'ceramic-tea-sets': [
    { n: 'Kesar Glaze Ceramic Tea Set — 9 Pieces', m: 'ceramic', c: 'saffron', f: 'gloss', pcs: 9, comp: [['Teapot', 1], ['Cup', 4], ['Saucer', 4]], sv: 4, mrp: 3499, p: 2799, b: 'A saffron glaze as warm as the spice it is named after — teapot, four cups and saucers.', q: 'yellow ceramic teapot cups' },
    { n: 'Cobalt Swirl Ceramic Tea Set — 7 Pieces', m: 'ceramic', c: 'cobalt blue', f: 'gloss', ds: 'swirl', pcs: 7, comp: [['Teapot', 1], ['Cup', 6]], sv: 6, mrp: 2999, p: 2399, b: 'Hand-swirled cobalt over white — a teapot and six handle-less cups for sharing.', q: 'blue ceramic tea set' },
  ],
  'tea-cups-and-saucers': [
    { n: 'Pearl Lustre Tea Cups and Saucers Set of 6', m: 'porcelain', c: 'pearl', f: 'lustre', pcs: 12, comp: [['Cup', 6], ['Saucer', 6]], ml: 200, mrp: 2499, p: 1999, b: 'A soft pearl lustre glaze shimmers on these 200 ml porcelain cups and saucers.', q: 'tea cup saucer' },
    { n: 'Botanical Sketch Cup and Saucer Pair', m: 'bone_china', c: 'white', f: 'gloss', pa: 'botanical', pcs: 4, comp: [['Cup', 2], ['Saucer', 2]], ml: 220, mrp: 1799, p: 1499, b: 'Two bone china cups and saucers printed with hand-drawn botanical sketches.', q: 'floral tea cup saucer' },
  ],
  'coffee-cups': [
    { n: 'Café Crema Coffee Cups Set of 4', m: 'porcelain', c: 'cream', f: 'gloss', pcs: 4, ml: 250, mrp: 1499, p: 1199, b: 'Classic 250 ml café cups with a comfortable loop handle and a cream glaze.', q: 'coffee cup cream' },
    { n: 'Slate Ridge Coffee Cups with Saucers Set of 2', m: 'stoneware', c: 'slate', f: 'matte', ds: 'ribbed', pcs: 4, comp: [['Cup', 2], ['Saucer', 2]], ml: 240, mrp: 1299, p: 1049, b: 'Ribbed slate-grey stoneware cups with matching saucers — tactile and calm.', q: 'grey coffee cup saucer' },
  ],
  'coffee-mugs': [
    { n: 'Ember Speckled Coffee Mugs Set of 4', m: 'stoneware', c: 'speckled white', f: 'satin', pcs: 4, ml: 380, mrp: 1799, p: 1399, b: 'Generous 380 ml mugs in speckled white stoneware with an ember-brown rim.', q: 'speckled ceramic mug' },
    { n: 'Midnight Glaze Coffee Mug — 450 ml', m: 'ceramic', c: 'navy', f: 'gloss', pcs: 1, ml: 450, mrp: 599, p: 499, b: 'A deep navy mug sized at 450 ml for long coffees and big cups of cocoa.', q: 'navy blue coffee mug' },
  ],
  'espresso-cups': [
    { n: 'Ristretto Espresso Cups Set of 6', m: 'porcelain', c: 'white', f: 'gloss', pcs: 6, ml: 80, mrp: 1299, p: 1049, b: 'Thick-walled 80 ml porcelain cups that hold the heat of a fresh espresso shot.', q: 'espresso cup' },
    { n: 'Copper Glaze Espresso Cups and Saucers Set of 4', m: 'ceramic', c: 'copper', f: 'metallic glaze', pcs: 8, comp: [['Cup', 4], ['Saucer', 4]], ml: 90, mrp: 1799, p: 1499, b: 'A metallic copper glaze on small espresso cups with saucers, for an after-dinner flourish.', q: 'espresso cup saucer' },
  ],
  'cappuccino-cups': [
    { n: 'Latte Art Cappuccino Cups Set of 4', m: 'porcelain', c: 'white', f: 'gloss', ds: 'wide bowl', pcs: 8, comp: [['Cup', 4], ['Saucer', 4]], ml: 280, mrp: 1999, p: 1599, b: 'Wide 280 ml bowls that show off a good microfoam pour, with matching saucers.', q: 'cappuccino cup latte art' },
    { n: 'Mocha Two-Tone Cappuccino Cups Set of 2', m: 'stoneware', c: 'brown and cream', f: 'gloss and matte', pcs: 4, comp: [['Cup', 2], ['Saucer', 2]], ml: 300, mrp: 1199, p: 999, b: 'Glossy cream inside, matte mocha outside — a pair of café-style cappuccino cups.', q: 'brown cappuccino cup' },
  ],
  teapots: [
    { n: 'Assam Round Belly Teapot — 1 L', m: 'stoneware', c: 'olive', f: 'satin', pcs: 1, ml: 1000, mrp: 1999, p: 1599, b: 'A round-bellied 1 litre teapot in olive stoneware with a removable infuser for loose leaf tea.', q: 'ceramic teapot' },
    { n: 'Blossom Porcelain Teapot — 800 ml', m: 'porcelain', c: 'white', f: 'gloss', pa: 'floral', pcs: 1, ml: 800, mrp: 1799, p: 1449, b: 'An 800 ml porcelain teapot painted with pale cherry blossom.', q: 'white floral teapot' },
  ],
  'coffee-pots': [
    { n: 'Barista Ceramic Coffee Server — 900 ml', m: 'ceramic', c: 'black', f: 'matte', pcs: 1, ml: 900, mrp: 1899, p: 1549, b: 'A tall matte-black server for pour-over and French-press coffee, with a drip-free spout.', q: 'coffee pot ceramic' },
    { n: 'Café au Lait Porcelain Coffee Pot — 1.2 L', m: 'porcelain', c: 'white', f: 'gloss', pcs: 1, ml: 1200, mrp: 2199, p: 1799, b: 'A classic lidded porcelain coffee pot that serves six cups at the table.', q: 'white coffee pot' },
  ],
  'milk-jugs': [
    { n: 'Dairy Farm Milk Jug — 500 ml', m: 'stoneware', c: 'white', f: 'satin', pcs: 1, ml: 500, mrp: 899, p: 749, b: 'A sturdy 500 ml jug with a generous lip for milk, buttermilk or gravy.', q: 'ceramic milk jug' },
    { n: 'Petite Creamer Jugs Set of 2', m: 'porcelain', c: 'blush and grey', f: 'gloss', pcs: 2, ml: 150, mrp: 799, p: 649, b: 'Two little 150 ml creamers in blush and grey for tea trays and coffee service.', q: 'small creamer jug' },
  ],
  'sugar-pots': [
    { n: 'Honeycomb Lidded Sugar Pot', m: 'ceramic', c: 'honey', f: 'gloss', ds: 'honeycomb relief', pcs: 1, ml: 300, mrp: 699, p: 579, b: 'A honey-glazed sugar pot with a honeycomb relief and a notch in the lid for the spoon.', q: 'sugar bowl lid' },
    { n: 'Classic White Sugar Bowl with Spoon', m: 'porcelain', c: 'white', f: 'gloss', pcs: 2, comp: [['Sugar bowl', 1], ['Spoon', 1]], ml: 250, mrp: 749, p: 599, b: 'A footed porcelain sugar bowl with a fitted lid and a matching spoon.', q: 'white sugar bowl spoon' },
  ],
  'tea-and-coffee-gift-sets': [
    { n: 'Morning Brew Mug Gift Box — Set of 2', m: 'stoneware', c: 'teal and sand', f: 'reactive glaze', pcs: 2, ml: 350, mrp: 1499, p: 1199, b: 'Two reactive-glaze mugs in a keepsake gift box — a thoughtful present for coffee and tea lovers.', q: 'mug gift box' },
    { n: 'Tea Ceremony Gift Set — Teapot and 4 Cups', m: 'ceramic', c: 'jade', f: 'crackle glaze', pcs: 5, comp: [['Teapot', 1], ['Cup', 4]], mrp: 2999, p: 2499, b: 'A jade crackle-glaze teapot with four small cups, gift-boxed for festivals and housewarmings.', q: 'tea set gift' },
  ],

  // ------------------------------------------------------------------ Glassware
  glassware: [
    { n: 'Crystal Clear Everyday Glassware Set — 12 Pieces', m: 'glass', c: 'clear', f: 'polished', pcs: 12, comp: [['Water glass', 6], ['Juice glass', 6]], mrp: 1999, p: 1599, b: 'Six water glasses and six juice glasses in clear, polished glass — the glassware basics for any home.', q: 'clear drinking glasses set' },
    { n: 'Smoke Tint Glassware Collection — 8 Pieces', m: 'glass', c: 'smoke grey', f: 'tinted', pcs: 8, comp: [['Tumbler', 4], ['Highball', 4]], mrp: 2499, p: 1999, b: 'Smoky grey tumblers and highballs for a moody, modern bar cart.', q: 'grey tinted glasses' },
  ],
  'drinking-glasses': [
    { n: 'Ripple Drinking Glasses Set of 6 — 300 ml', m: 'glass', c: 'clear', f: 'ribbed', pcs: 6, ml: 300, mrp: 1199, p: 949, b: 'Ribbed glasses that catch the light and give a confident grip — for water, juice or iced coffee.', q: 'ribbed drinking glass' },
    { n: 'Amber Retro Drinking Glasses Set of 4', m: 'glass', c: 'amber', f: 'tinted', pcs: 4, ml: 320, mrp: 1099, p: 899, b: 'Warm amber glasses with a 70s feel, sized at 320 ml.', q: 'amber drinking glasses' },
  ],
  'water-glasses': [
    { n: 'Aqua Pure Water Glasses Set of 6 — 350 ml', m: 'glass', c: 'clear', f: 'polished', pcs: 6, ml: 350, mrp: 999, p: 799, b: 'Simple, straight-sided 350 ml water glasses with a thin rim.', q: 'water glass' },
    { n: 'Hammered Water Glasses Set of 4', m: 'glass', c: 'clear', f: 'hammered', pcs: 4, ml: 330, mrp: 1199, p: 949, b: 'A hammered texture makes these 330 ml glasses sparkle on the table.', q: 'textured water glasses' },
  ],
  'juice-glasses': [
    { n: 'Sunrise Juice Glasses Set of 6 — 200 ml', m: 'glass', c: 'clear', f: 'polished', pcs: 6, ml: 200, mrp: 799, p: 649, b: 'Short 200 ml glasses for fresh juice at breakfast.', q: 'orange juice glass' },
    { n: 'Faceted Juice Glasses Set of 4', m: 'glass', c: 'clear', f: 'faceted', pcs: 4, ml: 220, mrp: 899, p: 749, b: 'Faceted sides refract colour beautifully — perfect for bright juices and sherbets.', q: 'faceted juice glass' },
  ],
  'highball-glasses': [
    { n: 'Tall Fluted Highball Glasses Set of 4 — 400 ml', m: 'glass', c: 'clear', f: 'fluted', pcs: 4, ml: 400, mrp: 1299, p: 1049, b: 'Tall 400 ml fluted highballs for long drinks, lemonades and mocktails.', q: 'highball glass cocktail' },
    { n: 'Gold Rim Highball Glasses Set of 6', m: 'glass', c: 'clear', f: 'polished', ds: 'gold rim', pcs: 6, ml: 380, mrp: 1799, p: 1449, b: 'Slim highballs finished with a fine gold rim for parties and celebrations.', q: 'gold rim glasses' },
  ],
  tumblers: [
    { n: 'Heavy Base Old Fashioned Tumblers Set of 4 — 300 ml', m: 'glass', c: 'clear', f: 'polished', pcs: 4, ml: 300, mrp: 1499, p: 1199, b: 'A thick, weighted base and a wide mouth — the classic rocks glass.', q: 'whiskey tumbler glass' },
    { n: 'Diamond Cut Tumblers Set of 6', m: 'glass', c: 'clear', f: 'diamond cut', pcs: 6, ml: 280, mrp: 1699, p: 1349, b: 'Diamond-cut tumblers that throw sparkles across the table.', q: 'cut glass tumbler' },
  ],
  'crystal-glassware': [
    { n: 'Regency Cut Crystal Tumblers Set of 2', m: 'crystal_glass', c: 'clear', f: 'hand cut', ds: 'regency cut', pcs: 2, ml: 320, mrp: 3999, p: 3299, b: 'A pair of weighty crystal tumblers with a deep, hand-cut regency pattern.', q: 'crystal glass' },
    { n: 'Etoile Crystal Wine Glasses Set of 2', m: 'crystal_glass', c: 'clear', f: 'polished', pcs: 2, ml: 450, mrp: 3499, p: 2899, b: 'Fine-stemmed crystal wine glasses with a thin, ringing rim.', q: 'crystal wine glass' },
  ],
  'wine-glasses': [
    { n: 'Bordeaux Red Wine Glasses Set of 4 — 550 ml', m: 'glass', c: 'clear', f: 'polished', pcs: 4, ml: 550, mrp: 1999, p: 1599, b: 'Large 550 ml bowls that give bold red wines room to open up.', q: 'red wine glasses' },
    { n: 'Chardonnay White Wine Glasses Set of 6', m: 'glass', c: 'clear', f: 'polished', pcs: 6, ml: 380, mrp: 2299, p: 1849, b: 'Tulip-shaped 380 ml glasses designed for chilled white wine.', q: 'white wine glass' },
  ],
  'champagne-glasses': [
    { n: 'Celebration Champagne Flutes Set of 4', m: 'glass', c: 'clear', f: 'polished', pcs: 4, ml: 200, mrp: 1799, p: 1449, b: 'Slender flutes that keep the bubbles lively — made for toasts.', q: 'champagne flutes' },
    { n: 'Gatsby Champagne Coupes Set of 2', m: 'glass', c: 'clear', f: 'etched', ds: 'art deco etching', pcs: 2, ml: 220, mrp: 1599, p: 1299, b: 'Art-deco etched coupes for a vintage celebration.', q: 'champagne coupe glass' },
  ],
  'dessert-glasses': [
    { n: 'Parfait Dessert Glasses Set of 6 — 250 ml', m: 'glass', c: 'clear', f: 'polished', pcs: 6, ml: 250, mrp: 1199, p: 949, b: 'Tall 250 ml glasses that show off layered desserts, trifles and parfaits.', q: 'dessert in glass' },
    { n: 'Footed Sundae Bowls Set of 4', m: 'glass', c: 'clear', f: 'polished', pcs: 4, ml: 300, mrp: 1099, p: 899, b: 'Footed glass bowls for ice cream sundaes, kulfi and fruit salad.', q: 'ice cream sundae glass' },
  ],
  'glass-jugs': [
    { n: 'Lemonade Glass Jug with Lid — 1.5 L', m: 'glass', c: 'clear', f: 'polished', pcs: 1, ml: 1500, mrp: 1299, p: 1049, b: 'A 1.5 litre jug with a fitted lid that keeps out insects at outdoor tables.', q: 'glass pitcher lemonade' },
    { n: 'Ribbed Glass Pitcher — 1.2 L', m: 'glass', c: 'clear', f: 'ribbed', pcs: 1, ml: 1200, mrp: 1199, p: 949, b: 'A ribbed glass pitcher with a pinched spout for water, juice and nimbu pani.', q: 'glass jug water' },
  ],
  carafes: [
    { n: 'Bedside Water Carafe with Tumbler — 1 L', m: 'glass', c: 'clear', f: 'polished', pcs: 2, comp: [['Carafe', 1], ['Tumbler', 1]], ml: 1000, mrp: 1199, p: 999, b: 'A carafe whose tumbler doubles as a lid — for the bedside or the desk.', q: 'water carafe glass' },
    { n: 'Sommelier Wine Decanter — 1.5 L', m: 'glass', c: 'clear', f: 'polished', pcs: 1, ml: 1500, mrp: 2499, p: 1999, b: 'A wide-based decanter that lets red wine breathe before serving.', q: 'wine decanter' },
  ],
  'glass-serving-bowls': [
    { n: 'Crystal Clear Salad Bowl — 25 cm', m: 'glass', c: 'clear', f: 'polished', pcs: 1, dim: D(250, 110), mrp: 1299, p: 1049, b: 'A generous 25 cm glass bowl that shows off colourful salads and fruit.', q: 'glass salad bowl' },
    { n: 'Nesting Glass Serving Bowls Set of 3', m: 'glass', c: 'clear', f: 'polished', pcs: 3, mrp: 1599, p: 1299, b: 'Three nesting glass bowls in small, medium and large for serving and prep.', q: 'glass bowls' },
  ],

  // ------------------------------------------------------------------ Serving Essentials
  'serving-essentials': [
    { n: 'Hosting Essentials Serveware Set — 5 Pieces', m: 'ceramic', c: 'white', f: 'gloss', pcs: 5, comp: [['Serving platter', 1], ['Serving bowl', 2], ['Dip bowl', 2]], mrp: 3999, p: 3199, b: 'A platter, two serving bowls and two dip bowls — everything you need to host a dinner party.', q: 'serving dishes table food' },
    { n: 'Mango Wood and Ceramic Serving Board', m: 'wood', ms: ['wood', 'ceramic'], c: 'natural', f: 'oiled', pcs: 3, comp: [['Board', 1], ['Dip bowl', 2]], dim: L(450, 200), mrp: 2499, p: 1999, b: 'A mango-wood board with two inset ceramic bowls for cheese, crackers and dips.', q: 'wooden serving board' },
  ],
  'serving-platters': [
    { n: 'Banquet Oval Serving Platter — 40 cm', m: 'porcelain', c: 'white', f: 'gloss', pcs: 1, dim: L(400, 280), mrp: 1999, p: 1599, b: 'A 40 cm oval platter for roasts, biryani and celebration spreads.', q: 'oval serving platter' },
    { n: 'Organic Edge Stoneware Platter — 35 cm', m: 'stoneware', c: 'speckled grey', f: 'matte', pcs: 1, dim: L(350, 240), mrp: 1799, p: 1449, b: 'A free-form stoneware platter with a hand-shaped organic edge.', q: 'ceramic platter food' },
  ],
  'serving-bowls': [
    { n: 'Family Feast Serving Bowl — 2 L', m: 'stoneware', c: 'cream', f: 'satin', pcs: 1, ml: 2000, dim: D(250, 100), mrp: 1499, p: 1199, b: 'A 2 litre bowl big enough for a family serving of dal, curry or salad.', q: 'large serving bowl' },
    { n: 'Lotus Serving Bowls Set of 2', m: 'porcelain', c: 'white', f: 'gloss', ds: 'lotus petal', pcs: 2, ml: 1200, mrp: 1799, p: 1449, b: 'Two lotus-petal bowls that bring a graceful touch to festive meals.', q: 'white serving bowl' },
  ],
  'serving-trays': [
    { n: 'Brass Handle Wooden Serving Tray', m: 'wood', ms: ['wood', 'brass'], c: 'walnut', f: 'lacquered', pcs: 1, dim: L(450, 300), mrp: 1999, p: 1599, b: 'A walnut-finish tray with brass handles for serving tea and drinks.', q: 'wooden serving tray' },
    { n: 'Marble Effect Rectangular Tray', m: 'resin', c: 'white marble', f: 'polished', pcs: 1, dim: L(400, 250), mrp: 1499, p: 1199, b: 'A marble-effect tray for drinks, perfumes or the coffee table.', q: 'marble tray' },
  ],
  'snack-plates': [
    { n: 'Mezze Snack Plates Set of 6', m: 'ceramic', c: 'assorted', f: 'gloss', pcs: 6, dim: D(150), mrp: 1299, p: 1049, b: 'Six small plates in six soft colours for snacks, starters and mezze.', q: 'small snack plates' },
    { n: 'Leaf Shaped Snack Plates Set of 4', m: 'stoneware', c: 'green', f: 'reactive glaze', ds: 'leaf shape', pcs: 4, dim: L(200, 120), mrp: 1199, p: 949, b: 'Leaf-shaped plates in green glaze for pakoras, chaat and canapés.', q: 'leaf shaped plate' },
  ],
  'dip-bowls': [
    { n: 'Chutney Dip Bowls Set of 6', m: 'ceramic', c: 'assorted', f: 'gloss', pcs: 6, ml: 80, mrp: 799, p: 649, b: 'Small 80 ml bowls for chutneys, sauces and dips in assorted glazes.', q: 'small dip bowls' },
    { n: 'Petal Dip Bowls Set of 4', m: 'porcelain', c: 'white', f: 'gloss', ds: 'petal', pcs: 4, ml: 100, mrp: 699, p: 579, b: 'Petal-shaped porcelain bowls for sauces, pickles and nuts.', q: 'sauce dish' },
  ],
  'condiment-sets': [
    { n: 'Achaar Condiment Set with Tray — 4 Jars', m: 'ceramic', c: 'white', f: 'gloss', pcs: 5, comp: [['Lidded jar', 4], ['Tray', 1]], mrp: 1499, p: 1199, b: 'Four lidded jars on a matching tray for pickles and chutneys at the table.', q: 'condiment jars' },
    { n: 'Revolving Condiment Caddy — 3 Bowls', m: 'wood', ms: ['wood', 'ceramic'], c: 'natural', f: 'oiled', pcs: 4, comp: [['Bowl', 3], ['Caddy', 1]], mrp: 1299, p: 1049, b: 'Three ceramic bowls on a wooden caddy for sauces, toppings and garnishes.', q: 'condiment set table' },
  ],
  'cake-stands': [
    { n: 'Pedestal Cake Stand with Dome — 28 cm', m: 'glass', c: 'clear', f: 'polished', pcs: 2, comp: [['Stand', 1], ['Dome', 1]], dim: D(280), mrp: 2499, p: 1999, b: 'A footed glass stand with a dome that keeps cakes fresh and on display.', q: 'cake stand glass dome' },
    { n: 'Three Tier Porcelain Cake Stand', m: 'porcelain', c: 'white', f: 'gloss', ds: 'gold handle', pcs: 1, mrp: 2199, p: 1799, b: 'Three porcelain tiers on a gold handle for afternoon tea and pastries.', q: 'tiered cake stand' },
  ],
  'chip-and-dip-sets': [
    { n: 'Fiesta Chip and Dip Server', m: 'ceramic', c: 'terracotta', f: 'gloss', pcs: 2, comp: [['Platter', 1], ['Dip bowl', 1]], dim: D(320), mrp: 1499, p: 1199, b: 'A wide platter with a nested centre bowl for chips and salsa.', q: 'chips and dip bowl' },
    { n: 'Two-Compartment Chip and Dip Bowl', m: 'stoneware', c: 'cream', f: 'matte', pcs: 1, dim: L(300, 180), mrp: 1199, p: 949, b: 'A divided stoneware bowl that keeps chips and dip side by side.', q: 'snack bowl chips' },
  ],
  'salad-servers': [
    { n: 'Acacia Wood Salad Servers', m: 'wood', c: 'natural', f: 'oiled', pcs: 2, dim: L(300, 70), mrp: 699, p: 579, b: 'A pair of carved acacia-wood servers for tossing and serving salads.', q: 'wooden salad servers' },
    { n: 'Brushed Gold Salad Servers', m: 'stainless_steel', c: 'gold', f: 'brushed', pcs: 2, dim: L(260, 60), mrp: 999, p: 799, b: 'Brushed gold-tone steel servers for elegant buffet tables.', q: 'salad servers' },
  ],
  'serving-accessories': [
    { n: 'Cheese Knife Set of 4 with Board', m: 'wood', ms: ['wood', 'stainless_steel'], c: 'natural', f: 'oiled', pcs: 5, comp: [['Cheese knife', 4], ['Board', 1]], mrp: 1799, p: 1449, b: 'Four cheese knives and a wooden board for hosting cheese platters.', q: 'cheese knives board' },
    { n: 'Serving Tongs and Ladle Set — 3 Pieces', m: 'stainless_steel', c: 'silver', f: 'mirror polish', pcs: 3, comp: [['Tongs', 1], ['Ladle', 1], ['Slotted spoon', 1]], mrp: 999, p: 799, b: 'Mirror-polished tongs, ladle and slotted spoon for buffet service.', q: 'serving tongs ladle' },
  ],

  // ------------------------------------------------------------------ Cutlery and Table Accessories
  'cutlery-and-table-accessories': [
    { n: 'Complete Table Setting Kit — 30 Pieces', m: 'stainless_steel', c: 'silver', f: 'mirror polish', pcs: 30, comp: [['Dinner fork', 6], ['Dinner knife', 6], ['Dinner spoon', 6], ['Tea spoon', 6], ['Dessert fork', 6]], sv: 6, mrp: 3999, p: 3199, b: 'A thirty-piece cutlery set for six with dessert forks and tea spoons included.', q: 'table setting cutlery' },
    { n: 'Table Finishing Set — Napkin Holder, Salt and Pepper', m: 'wood', ms: ['wood', 'ceramic'], c: 'natural', f: 'oiled', pcs: 3, comp: [['Napkin holder', 1], ['Salt shaker', 1], ['Pepper shaker', 1]], mrp: 1299, p: 1049, b: 'A matching napkin holder and salt and pepper pair to finish the dining table.', q: 'salt pepper napkin holder' },
  ],
  'cutlery-sets': [
    { n: 'Milano Mirror Cutlery Set — 24 Pieces', m: 'stainless_steel', c: 'silver', f: 'mirror polish', pcs: 24, comp: [['Dinner fork', 6], ['Dinner knife', 6], ['Dinner spoon', 6], ['Tea spoon', 6]], sv: 6, mrp: 2999, p: 2399, b: 'Classic mirror-polished cutlery for six with balanced, comfortable handles.', q: 'stainless steel cutlery set' },
    { n: 'Matte Black Cutlery Set — 16 Pieces', m: 'stainless_steel', c: 'black', f: 'matte', pcs: 16, comp: [['Dinner fork', 4], ['Dinner knife', 4], ['Dinner spoon', 4], ['Tea spoon', 4]], sv: 4, mrp: 2799, p: 2249, b: 'Sleek matte-black cutlery for four that looks striking on light tableware.', q: 'black cutlery' },
  ],
  'spoon-sets': [
    { n: 'Hammered Dinner Spoons Set of 6', m: 'stainless_steel', c: 'silver', f: 'hammered', pcs: 6, mrp: 899, p: 749, b: 'Dinner spoons with a hand-hammered handle texture.', q: 'spoons' },
    { n: 'Gold Tea Spoons Set of 6', m: 'stainless_steel', c: 'gold', f: 'polished', pcs: 6, mrp: 799, p: 649, b: 'Small gold-tone tea spoons for tea trays and dessert service.', q: 'gold spoons' },
  ],
  'fork-sets': [
    { n: 'Classic Dinner Forks Set of 6', m: 'stainless_steel', c: 'silver', f: 'mirror polish', pcs: 6, mrp: 899, p: 749, b: 'Four-tined mirror-polished dinner forks with a classic silhouette.', q: 'dinner forks' },
    { n: 'Rose Gold Dessert Forks Set of 6', m: 'stainless_steel', c: 'rose gold', f: 'polished', pcs: 6, mrp: 999, p: 799, b: 'Petite rose-gold forks for cake, pastries and fruit.', q: 'dessert forks' },
  ],
  'knife-sets': [
    { n: 'Serrated Steak Knives Set of 4', m: 'stainless_steel', c: 'silver', f: 'brushed', pcs: 4, mrp: 1499, p: 1199, b: 'Serrated table knives that cut cleanly through grilled meats and breads.', q: 'steak knives' },
    { n: 'Butter Knives with Wooden Handles Set of 4', m: 'wood', ms: ['wood', 'stainless_steel'], c: 'natural', f: 'oiled', pcs: 4, mrp: 799, p: 649, b: 'Short-bladed spreaders with wooden handles for butter, jam and pâté.', q: 'butter knife wooden handle' },
  ],
  'serving-spoons': [
    { n: 'Buffet Serving Spoons Set of 4', m: 'stainless_steel', c: 'silver', f: 'mirror polish', pcs: 4, mrp: 999, p: 799, b: 'Large serving spoons for rice, curries and sides.', q: 'serving spoon' },
    { n: 'Brass Finish Serving Ladles Set of 2', m: 'brass', c: 'brass', f: 'polished', pcs: 2, mrp: 1199, p: 949, b: 'Brass-finish ladles that bring warmth to festive serving.', q: 'brass ladle' },
  ],
  'stainless-steel-cutlery': [
    { n: 'Brushed Satin Cutlery Set — 20 Pieces', m: 'stainless_steel', c: 'silver', f: 'brushed satin', pcs: 20, comp: [['Dinner fork', 4], ['Dinner knife', 4], ['Dinner spoon', 4], ['Tea spoon', 4], ['Dessert spoon', 4]], sv: 4, mrp: 2499, p: 1999, b: 'A brushed satin finish that hides fingerprints, in a twenty-piece set for four.', q: 'brushed steel cutlery' },
    { n: 'Bistro Stainless Steel Cutlery Set — 12 Pieces', m: 'stainless_steel', c: 'silver', f: 'mirror polish', pcs: 12, comp: [['Dinner fork', 4], ['Dinner knife', 4], ['Dinner spoon', 4]], sv: 4, mrp: 1499, p: 1199, b: 'Robust bistro-style cutlery for everyday family meals.', q: 'stainless steel fork knife' },
  ],
  'napkin-holders': [
    { n: 'Marble and Wood Napkin Holder', m: 'other', c: 'white and natural', f: 'polished', pcs: 1, dim: L(180, 60, 120), mrp: 999, p: 799, b: 'A heavy marble base with a wooden arm keeps napkins in place.', q: 'napkin holder' },
    { n: 'Brass Wire Napkin Stand', m: 'brass', c: 'brass', f: 'brushed', pcs: 1, dim: L(170, 70, 110), mrp: 899, p: 749, b: 'A minimal brushed-brass stand for paper napkins.', q: 'napkins table' },
  ],
  'salt-and-pepper-sets': [
    { n: 'Pebble Ceramic Salt and Pepper Shakers', m: 'ceramic', c: 'black and white', f: 'matte', pcs: 2, mrp: 699, p: 579, b: 'Smooth, pebble-shaped shakers in black and white ceramic.', q: 'salt and pepper shakers' },
    { n: 'Acacia Wood Salt and Pepper Grinders', m: 'wood', c: 'natural', f: 'oiled', pcs: 2, mrp: 1299, p: 1049, b: 'Tall acacia grinders with adjustable ceramic mechanisms.', q: 'pepper grinder wood' },
  ],
  coasters: [
    { n: 'Cork and Ceramic Coasters Set of 6', m: 'ceramic', ms: ['ceramic', 'other'], c: 'assorted', f: 'gloss', pcs: 6, dim: D(100), mrp: 899, p: 749, b: 'Glazed ceramic coasters backed with cork to protect your table.', q: 'ceramic coasters' },
    { n: 'Marble Coasters with Holder Set of 4', m: 'other', c: 'white marble', f: 'polished', pcs: 5, comp: [['Coaster', 4], ['Holder', 1]], dim: D(100), mrp: 1199, p: 949, b: 'Four marble coasters with a matching holder for the coffee table.', q: 'marble coasters' },
  ],
  'table-accessories': [
    { n: 'Woven Bread Basket with Liner', m: 'other', ms: ['other', 'fabric'], c: 'natural', f: 'woven', pcs: 2, comp: [['Basket', 1], ['Cotton liner', 1]], dim: L(300, 200, 90), mrp: 999, p: 799, b: 'A woven basket with a removable cotton liner for rotis, bread and rolls.', q: 'bread basket' },
    { n: 'Cast Iron Trivet', m: 'other', c: 'black', f: 'matte', pcs: 1, dim: D(200), mrp: 799, p: 649, b: 'A decorative cast-iron trivet for hot pots and serving dishes.', q: 'trivet table' },
  ],

  // ------------------------------------------------------------------ Kitchen Storage
  'kitchen-storage': [
    { n: 'Pantry Organisation Starter Set — 9 Pieces', m: 'glass', ms: ['glass', 'bamboo'], c: 'clear', f: 'polished', pcs: 9, comp: [['Storage jar', 3], ['Spice jar', 6]], mrp: 2499, p: 1999, b: 'Three tall jars and six spice jars with bamboo lids to tidy up the pantry.', q: 'pantry jars organized' },
    { n: 'Countertop Canister Trio', m: 'ceramic', c: 'white', f: 'gloss', pcs: 3, mrp: 1799, p: 1449, b: 'Three graduated ceramic canisters for tea, coffee and sugar.', q: 'kitchen canisters' },
  ],
  'storage-jars': [
    { n: 'Bamboo Lid Storage Jars Set of 4 — 1 L', m: 'glass', ms: ['glass', 'bamboo'], c: 'clear', f: 'polished', pcs: 4, ml: 1000, mrp: 1499, p: 1199, b: 'Clear 1 litre jars with bamboo lids and a silicone seal for grains and pulses.', q: 'glass jars bamboo lids' },
    { n: 'Swing Top Storage Jars Set of 3', m: 'glass', c: 'clear', f: 'polished', pcs: 3, mrp: 1299, p: 1049, b: 'Clip-top jars in three sizes for flour, sugar and snacks.', q: 'swing top jar' },
  ],
  'ceramic-canisters': [
    { n: 'Glazed Ceramic Canister Set of 3', m: 'ceramic', c: 'sage', f: 'gloss', pcs: 3, mrp: 1999, p: 1599, b: 'Three sage-green canisters with wooden lids for tea, coffee and sugar.', q: 'ceramic canister' },
    { n: 'Hand-Painted Tea Canister', m: 'ceramic', c: 'blue and white', f: 'gloss', pa: 'floral', pcs: 1, mrp: 899, p: 749, b: 'A blue-and-white hand-painted canister for loose tea.', q: 'blue white ceramic jar' },
  ],
  'glass-storage-containers': [
    { n: 'Snap Lock Glass Containers Set of 4', m: 'glass', c: 'clear', f: 'polished', pcs: 4, mrp: 1599, p: 1299, b: 'Rectangular glass containers with snap-lock lids for leftovers and meal prep.', q: 'glass food container' },
    { n: 'Round Glass Containers with Lids Set of 3', m: 'glass', c: 'clear', f: 'polished', pcs: 3, mrp: 1199, p: 949, b: 'Three round glass containers in nesting sizes.', q: 'glass containers lids' },
  ],
  'food-storage-containers': [
    { n: 'Steel Tiffin Food Containers Set of 3', m: 'stainless_steel', c: 'silver', f: 'brushed', pcs: 3, mrp: 1299, p: 1049, b: 'Leak-resistant steel containers for packing lunch and storing food.', q: 'steel food container' },
    { n: 'Stackable Food Storage Boxes Set of 5', m: 'acrylic', c: 'clear', f: 'polished', pcs: 5, mrp: 999, p: 799, b: 'Stackable clear boxes that make fridge and pantry contents easy to see.', q: 'food storage containers' },
  ],
  'spice-jars': [
    { n: 'Glass Spice Jars Set of 12 with Labels', m: 'glass', c: 'clear', f: 'polished', pcs: 12, ml: 100, mrp: 1299, p: 1049, b: 'Twelve 100 ml glass spice jars with shaker inserts and labels.', q: 'spice jars' },
    { n: 'Ceramic Spice Pots Set of 6', m: 'ceramic', c: 'white', f: 'gloss', pcs: 6, mrp: 1199, p: 949, b: 'Six small lidded ceramic pots for whole spices.', q: 'spices in jars' },
  ],
  'spice-racks': [
    { n: 'Traditional Masala Dabba — 7 Bowls', m: 'stainless_steel', c: 'silver', f: 'mirror polish', pcs: 9, comp: [['Spice bowl', 7], ['Lid', 1], ['Spoon', 1]], mrp: 1199, p: 949, b: 'A classic steel masala box with seven bowls, a lid and a measuring spoon.', q: 'masala dabba spice box' },
    { n: 'Wall Mounted Wooden Spice Rack', m: 'wood', c: 'natural', f: 'oiled', pcs: 1, dim: L(400, 100, 300), mrp: 1499, p: 1199, b: 'A three-shelf wooden rack that keeps spices visible and within reach.', q: 'spice rack' },
  ],
  'oil-dispensers': [
    { n: 'Drip-Free Glass Oil Dispenser — 500 ml', m: 'glass', c: 'clear', f: 'polished', pcs: 1, ml: 500, mrp: 699, p: 579, b: 'A 500 ml glass dispenser with a flip-top spout for controlled pouring.', q: 'oil dispenser bottle' },
    { n: 'Steel Oil Can with Strainer — 1 L', m: 'stainless_steel', c: 'silver', f: 'brushed', pcs: 1, ml: 1000, mrp: 899, p: 749, b: 'A 1 litre steel oil can with a fine strainer and a narrow spout.', q: 'olive oil bottle kitchen' },
  ],
  'oil-and-vinegar-bottles': [
    { n: 'Cruet Set — Oil and Vinegar with Stand', m: 'glass', ms: ['glass', 'wood'], c: 'clear', f: 'polished', pcs: 3, comp: [['Bottle', 2], ['Stand', 1]], ml: 250, mrp: 1199, p: 949, b: 'Two 250 ml cruets on a wooden stand for oil and vinegar at the table.', q: 'oil vinegar bottles' },
    { n: 'Ceramic Oil and Vinegar Pourers', m: 'ceramic', c: 'white', f: 'matte', pcs: 2, ml: 300, mrp: 999, p: 799, b: 'Matte ceramic pourers labelled for oil and vinegar.', q: 'ceramic oil bottle' },
  ],
  'kitchen-organizers': [
    { n: 'Ceramic Utensil Holder', m: 'ceramic', c: 'charcoal', f: 'matte', pcs: 1, dim: D(120, 160), mrp: 799, p: 649, b: 'A weighty ceramic crock for spatulas, whisks and ladles.', q: 'utensil holder kitchen' },
    { n: 'Bamboo Drawer Organiser', m: 'bamboo', c: 'natural', f: 'oiled', pcs: 1, dim: L(400, 300, 50), mrp: 1199, p: 949, b: 'An expandable bamboo organiser for cutlery and kitchen tools.', q: 'kitchen drawer organizer' },
  ],
  'countertop-storage': [
    { n: 'Wire Fruit Basket with Banana Hook', m: 'stainless_steel', c: 'black', f: 'powder coated', pcs: 1, dim: D(280, 350), mrp: 1299, p: 1049, b: 'A two-tier fruit basket with a hook that keeps bananas from bruising.', q: 'fruit basket kitchen' },
    { n: 'Roll Top Bread Bin', m: 'bamboo', c: 'natural', f: 'oiled', pcs: 1, dim: L(400, 250, 200), mrp: 2499, p: 1999, b: 'A bamboo roll-top bin that keeps bread and pav fresh on the counter.', q: 'bread bin' },
  ],

  // ------------------------------------------------------------------ Bakeware and Ovenware
  'bakeware-and-ovenware': [
    { n: "Home Baker's Starter Set — 4 Pieces", m: 'stoneware', c: 'cream', f: 'gloss', pcs: 4, comp: [['Baking dish', 1], ['Pie dish', 1], ['Ramekin', 2]], mrp: 2999, p: 2399, b: 'A baking dish, a pie dish and two ramekins in cream stoneware for the home baker.', q: 'baking dishes' },
    { n: 'Rustic Bake and Serve Collection — 3 Pieces', m: 'stoneware', c: 'red', f: 'gloss', pcs: 3, mrp: 3499, p: 2799, b: 'Three graduated red stoneware dishes that look as good on the table as in the kitchen.', q: 'red baking dish' },
  ],
  'baking-dishes': [
    { n: 'Rectangular Stoneware Baking Dish — 33 cm', m: 'stoneware', c: 'white', f: 'gloss', pcs: 1, dim: L(330, 220, 60), mrp: 1499, p: 1199, b: 'A 33 cm rectangular dish for lasagne, bakes and gratins.', q: 'lasagna baking dish' },
    { n: 'Oval Gratin Dish — 28 cm', m: 'ceramic', c: 'blue', f: 'gloss', pcs: 1, dim: L(280, 180, 50), mrp: 1199, p: 949, b: 'An oval dish with side handles for gratins and roasted vegetables.', q: 'gratin dish' },
  ],
  'casserole-dishes': [
    { n: 'Lidded Ceramic Casserole — 2 L', m: 'ceramic', c: 'red', f: 'gloss', pcs: 2, comp: [['Casserole', 1], ['Lid', 1]], ml: 2000, mrp: 1999, p: 1599, b: 'A 2 litre lidded casserole for slow-cooked dishes and family serving.', q: 'casserole dish' },
    { n: 'Hot Pot Insulated Casserole — 2.5 L', m: 'stainless_steel', c: 'silver', f: 'brushed', pcs: 1, ml: 2500, mrp: 1799, p: 1449, b: 'A double-walled casserole that keeps rotis and rice warm at the table.', q: 'serving casserole pot' },
  ],
  'oven-to-table-dishes': [
    { n: 'Square Bake and Serve Dish — 24 cm', m: 'stoneware', c: 'grey', f: 'reactive glaze', pcs: 1, dim: L(240, 240, 60), mrp: 1399, p: 1149, b: 'A square stoneware dish designed to go from kitchen to table for brownies, bakes and crumbles.', q: 'baked dish on table' },
    { n: 'Individual Bake and Serve Dishes Set of 4', m: 'porcelain', c: 'white', f: 'gloss', pcs: 4, dim: L(160, 110, 40), mrp: 1599, p: 1299, b: 'Four individual dishes for single-portion bakes, served straight to each guest.', q: 'individual baking dish' },
  ],
  'pie-dishes': [
    { n: 'Fluted Pie Dish — 26 cm', m: 'ceramic', c: 'white', f: 'gloss', ds: 'fluted edge', pcs: 1, dim: D(260, 45), mrp: 999, p: 799, b: 'A 26 cm fluted dish for pies, tarts and quiches.', q: 'pie dish' },
    { n: 'Deep Pie Dish with Handles — 24 cm', m: 'stoneware', c: 'sage', f: 'gloss', pcs: 1, dim: D(240, 60), mrp: 1199, p: 949, b: 'A deep pie dish with easy-carry handles for fruit pies and pot pies.', q: 'apple pie dish' },
  ],
  ramekins: [
    { n: 'Classic White Ramekins Set of 6', m: 'porcelain', c: 'white', f: 'gloss', ds: 'fluted', pcs: 6, ml: 150, mrp: 999, p: 799, b: 'Six 150 ml fluted ramekins for crème brûlée, dips and puddings.', q: 'white ramekins' },
    { n: 'Colourful Ramekins Set of 4', m: 'stoneware', c: 'assorted', f: 'gloss', pcs: 4, ml: 200, mrp: 899, p: 749, b: 'Four 200 ml ramekins in bright glazes for desserts and sides.', q: 'ramekin dessert' },
  ],
  'souffle-dishes': [
    { n: 'Straight-Sided Soufflé Dish — 1.2 L', m: 'porcelain', c: 'white', f: 'gloss', pcs: 1, ml: 1200, dim: D(180, 90), mrp: 1199, p: 949, b: 'A classic straight-sided 1.2 litre dish for soufflés, bakes and puddings.', q: 'souffle' },
    { n: 'Individual Soufflé Dishes Set of 4', m: 'porcelain', c: 'white', f: 'gloss', pcs: 4, ml: 250, mrp: 1299, p: 1049, b: 'Four individual 250 ml dishes for single-serve soufflés.', q: 'souffle dish' },
  ],
  'mixing-bowls': [
    { n: 'Nesting Steel Mixing Bowls Set of 5', m: 'stainless_steel', c: 'silver', f: 'brushed', pcs: 5, mrp: 1499, p: 1199, b: 'Five nesting steel bowls from 1 to 5 litres for mixing, whisking and prep.', q: 'mixing bowls' },
    { n: 'Stoneware Mixing Bowl with Spout — 3 L', m: 'stoneware', c: 'cream', f: 'gloss', pcs: 1, ml: 3000, mrp: 1799, p: 1449, b: 'A heavy 3 litre bowl with a pouring spout for batters and doughs.', q: 'ceramic mixing bowl' },
  ],
  'baking-accessories': [
    { n: 'Ceramic Pie Weights — 500 g', m: 'ceramic', c: 'natural', f: 'unglazed', pcs: 1, mrp: 599, p: 499, b: 'Reusable ceramic beads for blind-baking tart shells.', q: 'baking tools' },
    { n: 'Pastry Brush and Rolling Pin Set', m: 'wood', ms: ['wood', 'silicone'], c: 'natural', f: 'oiled', pcs: 2, comp: [['Rolling pin', 1], ['Pastry brush', 1]], mrp: 799, p: 649, b: 'A beech rolling pin and silicone pastry brush for pastry and rotis.', q: 'rolling pin baking' },
  ],

  // ------------------------------------------------------------------ Decorative Homeware
  'decorative-homeware': [
    { n: 'Console Styling Set — Vase, Bowl and Candle Holder', m: 'ceramic', c: 'ivory', f: 'matte', pcs: 3, mrp: 3999, p: 3199, b: 'A coordinated vase, bowl and candle holder in ivory matte for styling a console or shelf.', q: 'ceramic vase decor shelf' },
    { n: 'Moroccan Lantern Decor Pair', m: 'other', ms: ['other', 'glass'], c: 'gold', f: 'antique', pcs: 2, mrp: 2999, p: 2399, b: 'Two pierced-metal lanterns with glass panels that cast patterned light.', q: 'moroccan lantern' },
  ],
  'decorative-vases': [
    { n: 'Fluted Glass Bud Vase', m: 'glass', c: 'clear', f: 'fluted', pcs: 1, dim: D(80, 180), mrp: 799, p: 649, b: 'A small fluted glass vase for single stems and bud arrangements.', q: 'glass bud vase flower' },
    { n: 'Amphora Statement Vase — 40 cm', m: 'earthenware', c: 'terracotta', f: 'unglazed', pcs: 1, dim: D(220, 400), mrp: 2999, p: 2399, b: 'A tall terracotta amphora for dried grasses and branches.', q: 'large terracotta vase' },
  ],
  'ceramic-vases': [
    { n: 'Ribbed Matte Ceramic Vase — 25 cm', m: 'ceramic', c: 'white', f: 'matte', ds: 'ribbed', pcs: 1, dim: D(130, 250), mrp: 1499, p: 1199, b: 'Vertical ribs and a chalky matte finish give this vase a sculptural look.', q: 'white ceramic vase' },
    { n: 'Speckled Bottle Vase — 30 cm', m: 'stoneware', c: 'speckled cream', f: 'satin', pcs: 1, dim: D(120, 300), mrp: 1699, p: 1349, b: 'A slim-necked bottle vase in speckled stoneware.', q: 'ceramic vase speckled' },
  ],
  'sculptural-vases': [
    { n: 'Donut Ring Vase', m: 'ceramic', c: 'sand', f: 'matte', ds: 'ring', pcs: 1, dim: D(220, 230), mrp: 1999, p: 1599, b: 'A ring-shaped vase with a small opening for a single dramatic stem.', q: 'sculptural vase' },
    { n: 'Organic Wave Vase', m: 'ceramic', c: 'black', f: 'matte', pcs: 1, dim: D(150, 280), mrp: 2299, p: 1849, b: 'A twisting, wave-like silhouette in matte black ceramic.', q: 'modern black vase' },
  ],
  'decorative-bowls': [
    { n: 'Hand-Beaten Brass Decorative Bowl', m: 'brass', c: 'brass', f: 'hammered', pcs: 1, dim: D(250, 90), mrp: 2499, p: 1999, b: 'A hand-beaten brass bowl for a coffee table or entryway.', q: 'brass bowl' },
    { n: 'Glazed Footed Decorative Bowl', m: 'ceramic', c: 'teal', f: 'gloss', pcs: 1, dim: D(280, 120), mrp: 1999, p: 1599, b: 'A deep teal footed bowl to display fruit, potpourri or nothing at all.', q: 'decorative ceramic bowl' },
  ],
  'table-centerpieces': [
    { n: 'Wooden Centrepiece Tray with Candles', m: 'wood', c: 'natural', f: 'oiled', pcs: 1, dim: L(600, 180), mrp: 2499, p: 1999, b: 'A long wooden tray designed to hold pillar candles and greenery down the table.', q: 'table centerpiece candles' },
    { n: 'Ceramic Centrepiece Bowl — 35 cm', m: 'ceramic', c: 'white', f: 'gloss', pcs: 1, dim: D(350, 110), mrp: 2799, p: 2249, b: 'A wide, shallow centrepiece bowl for floating flowers and candles.', q: 'centerpiece bowl flowers' },
  ],
  'ceramic-showpieces': [
    { n: 'Ceramic Elephant Showpiece', m: 'ceramic', c: 'white and gold', f: 'gloss', pcs: 1, dim: L(200, 90, 160), mrp: 1799, p: 1449, b: 'A glazed elephant figure with gold detailing for shelves and consoles.', q: 'ceramic figurine' },
    { n: 'Abstract Ceramic Sculpture', m: 'ceramic', c: 'sand', f: 'matte', pcs: 1, dim: L(150, 80, 250), mrp: 2499, p: 1999, b: 'An abstract sculptural form in sand-toned ceramic.', q: 'ceramic sculpture' },
  ],
  'decorative-plates': [
    { n: 'Blue Pottery Wall Plate — 25 cm', m: 'ceramic', c: 'blue and white', f: 'gloss', pa: 'floral', pcs: 1, dim: D(250), mrp: 1499, p: 1199, b: 'A hand-painted blue pottery plate inspired by Jaipur craft, for wall display.', q: 'blue decorative plate' },
    { n: 'Gold Leaf Decorative Plate', m: 'porcelain', c: 'white and gold', f: 'gloss', pcs: 1, dim: D(280), mrp: 1999, p: 1599, b: 'A display plate with a gold-leaf centre for walls and plate stands.', q: 'decorative plate wall' },
  ],
  'candle-holders': [
    { n: 'Brass Taper Candle Holders Set of 3', m: 'brass', c: 'brass', f: 'polished', pcs: 3, mrp: 1799, p: 1449, b: 'Three brass taper holders in graduated heights.', q: 'brass candle holders' },
    { n: 'Smoked Glass Tea Light Holders Set of 4', m: 'glass', c: 'smoke grey', f: 'tinted', pcs: 4, mrp: 999, p: 799, b: 'Four smoked glass votives that give tea lights a soft glow.', q: 'tea light candle holder' },
  ],
  'decorative-accessories': [
    { n: 'Marble Trinket Tray', m: 'other', c: 'white marble', f: 'polished', pcs: 1, dim: L(200, 120), mrp: 999, p: 799, b: 'A small marble tray for jewellery, keys and bedside essentials.', q: 'trinket tray' },
    { n: 'Carved Wooden Keepsake Box', m: 'wood', c: 'walnut', f: 'lacquered', pcs: 1, dim: L(200, 150, 80), mrp: 1499, p: 1199, b: 'A hand-carved wooden box for keepsakes and small treasures.', q: 'wooden box decor' },
  ],

  // ------------------------------------------------------------------ Gift Collections
  'gift-collections': [
    { n: 'Signature Gift Hamper — Mugs, Coasters and Tray', m: 'ceramic', ms: ['ceramic', 'wood'], c: 'white', f: 'gloss', pcs: 5, comp: [['Mug', 2], ['Coaster', 2], ['Tray', 1]], mrp: 2999, p: 2499, b: 'Two mugs, two coasters and a serving tray, gift-wrapped and ready to give.', q: 'gift box ceramic mugs' },
    { n: 'Dinner for Two Gift Set — 8 Pieces', m: 'porcelain', c: 'white', f: 'gloss', ds: 'gold rim', pcs: 8, comp: [['Dinner plate', 2], ['Side plate', 2], ['Bowl', 2], ['Wine glass', 2]], mrp: 3999, p: 3299, b: 'Plates, bowls and wine glasses for two, in a gift box.', q: 'dinner for two table' },
  ],
  'premium-crockery-gift-sets': [
    { n: 'Imperial Gold Bone China Gift Set — 21 Pieces', m: 'bone_china', c: 'white', f: 'gloss', ds: 'gold border', pcs: 21, mrp: 15999, p: 12999, b: 'A luxurious twenty-one-piece bone china set with a gold border, presented in a gift box.', q: 'luxury dinnerware gold' },
    { n: 'Heirloom Porcelain Serveware Gift Set', m: 'porcelain', c: 'white', f: 'gloss', ds: 'platinum rim', pcs: 5, mrp: 6999, p: 5799, b: 'Platinum-rimmed serving platter and bowls, gift-boxed for special occasions.', q: 'porcelain serveware' },
  ],
  'wedding-gift-sets': [
    { n: 'Shubh Vivah Dinner Gift Set — 24 Pieces', m: 'porcelain', c: 'white', f: 'gloss', ds: 'gold rim', pcs: 24, sv: 6, mrp: 9999, p: 7999, b: 'A twenty-four-piece dinner set for newlyweds, in a gift box with a greeting card.', q: 'wedding table setting' },
    { n: 'Together Glassware Gift Set — 6 Pieces', m: 'glass', c: 'clear', f: 'polished', pcs: 6, comp: [['Wine glass', 2], ['Champagne flute', 2], ['Tumbler', 2]], mrp: 2999, p: 2499, b: 'Wine glasses, flutes and tumblers for two, gift-boxed for the couple.', q: 'glasses toast celebration' },
  ],
  'housewarming-gifts': [
    { n: 'New Home Breakfast Set — 8 Pieces', m: 'stoneware', c: 'sage', f: 'satin', pcs: 8, comp: [['Mug', 2], ['Bowl', 2], ['Plate', 2], ['Jam jar', 2]], mrp: 2999, p: 2499, b: 'Mugs, bowls, plates and jam jars for two — a warm welcome to a new home.', q: 'breakfast table ceramic' },
    { n: 'Griha Pravesh Serveware Gift Set', m: 'brass', c: 'brass', f: 'polished', pcs: 3, mrp: 3999, p: 3299, b: 'A polished brass bowl, platter and diya, gift-boxed for griha pravesh.', q: 'brass bowl decor' },
  ],
  'anniversary-gifts': [
    { n: 'Toast to Us Champagne Flutes Gift Pair', m: 'crystal_glass', c: 'clear', f: 'etched', pcs: 2, ml: 200, mrp: 2499, p: 1999, b: 'A pair of etched crystal flutes for anniversary toasts.', q: 'champagne glasses pair' },
    { n: 'Couple Mug and Coaster Gift Set', m: 'ceramic', c: 'white and black', f: 'gloss', pcs: 4, comp: [['Mug', 2], ['Coaster', 2]], mrp: 1499, p: 1199, b: 'Two mugs and coasters in black and white, gift-boxed for couples.', q: 'two coffee mugs' },
  ],
  'festive-gift-sets': [
    { n: 'Diwali Dry Fruit Serving Set', m: 'brass', ms: ['brass', 'wood'], c: 'brass', f: 'polished', pcs: 4, comp: [['Bowl', 3], ['Tray', 1]], mrp: 2999, p: 2399, b: 'Three brass bowls on a wooden tray for serving dry fruits and mithai.', q: 'diwali dry fruits' },
    { n: 'Festive Celebration Glassware Set', m: 'glass', c: 'clear', f: 'polished', ds: 'gold rim', pcs: 6, mrp: 2499, p: 1999, b: 'Six gold-rimmed glasses in a festive gift box.', q: 'festive glasses gold' },
  ],
  'corporate-gift-sets': [
    { n: 'Executive Desk Mug Gift Box', m: 'stoneware', c: 'charcoal', f: 'matte', pcs: 2, comp: [['Mug', 1], ['Coaster', 1]], mrp: 999, p: 849, b: 'An understated charcoal mug with a coaster in a branded-ready gift box.', q: 'black mug desk' },
    { n: 'Tea Tasting Corporate Gift Set', m: 'ceramic', c: 'white', f: 'gloss', pcs: 5, comp: [['Teapot', 1], ['Cup', 2], ['Saucer', 2]], mrp: 2499, p: 1999, b: 'A small teapot with two cups and saucers, ideal for client and team gifting.', q: 'white teapot cups' },
  ],

  // ------------------------------------------------------------------ Table Linen
  'table-linen': [
    { n: 'Complete Table Linen Set — Cloth, Runner and Napkins', m: 'fabric', c: 'natural', f: 'woven', pcs: 8, comp: [['Tablecloth', 1], ['Runner', 1], ['Napkin', 6]], mrp: 3499, p: 2799, b: 'A coordinated cotton tablecloth, runner and six napkins in natural tones.', q: 'table linen' },
    { n: 'Block Print Dining Linen Set', m: 'fabric', c: 'indigo', f: 'block printed', pa: 'block print', pcs: 7, comp: [['Runner', 1], ['Napkin', 6]], mrp: 2499, p: 1999, b: 'A hand block-printed runner and six napkins in indigo cotton.', q: 'block print fabric table' },
  ],
  tablecloths: [
    { n: 'Linen Blend Tablecloth — 6 Seater', m: 'fabric', c: 'oatmeal', f: 'stonewashed', pcs: 1, dim: L(2250, 1500), mrp: 2499, p: 1999, b: 'A soft, stonewashed linen-blend tablecloth for a six-seater table.', q: 'linen tablecloth' },
    { n: 'Gingham Check Cotton Tablecloth', m: 'fabric', c: 'red and white', f: 'woven', pa: 'gingham', pcs: 1, dim: L(1800, 1500), mrp: 1499, p: 1199, b: 'A cheerful gingham tablecloth for picnics and breakfast tables.', q: 'checkered tablecloth' },
  ],
  'table-runners': [
    { n: 'Tasselled Jute Table Runner', m: 'fabric', c: 'natural', f: 'woven', pcs: 1, dim: L(1800, 330), mrp: 999, p: 799, b: 'A woven jute runner with tasselled ends for a relaxed, natural table.', q: 'table runner' },
    { n: 'Velvet Festive Table Runner', m: 'fabric', c: 'emerald', f: 'velvet', pcs: 1, dim: L(1800, 350), mrp: 1499, p: 1199, b: 'A rich emerald velvet runner for festive dinners.', q: 'table runner dinner' },
  ],
  'cloth-napkins': [
    { n: 'Stonewashed Linen Napkins Set of 4', m: 'fabric', c: 'sage', f: 'stonewashed', pcs: 4, dim: L(450, 450), mrp: 1199, p: 949, b: 'Four soft linen napkins in sage, pre-washed for a relaxed drape.', q: 'linen napkins' },
    { n: 'Embroidered Cotton Napkins Set of 6', m: 'fabric', c: 'white', f: 'embroidered', pcs: 6, dim: L(400, 400), mrp: 1499, p: 1199, b: 'White cotton napkins with a hand-embroidered corner motif.', q: 'cloth napkins table' },
  ],
  placemats: [
    { n: 'Woven Water Hyacinth Placemats Set of 4', m: 'other', c: 'natural', f: 'woven', pcs: 4, dim: D(380), mrp: 1299, p: 1049, b: 'Round placemats hand-woven from water hyacinth.', q: 'woven placemats' },
    { n: 'Faux Leather Placemats Set of 6', m: 'other', c: 'tan', f: 'textured', pcs: 6, dim: L(450, 300), mrp: 1499, p: 1199, b: 'Wipe-clean faux leather placemats in a warm tan.', q: 'placemat table setting' },
  ],
  'napkin-rings': [
    { n: 'Brass Leaf Napkin Rings Set of 6', m: 'brass', c: 'brass', f: 'polished', pcs: 6, mrp: 1199, p: 949, b: 'Leaf-shaped brass napkin rings for festive table settings.', q: 'napkin ring' },
    { n: 'Wooden Bead Napkin Rings Set of 4', m: 'wood', c: 'natural', f: 'oiled', pcs: 4, mrp: 699, p: 579, b: 'Wooden bead rings that add a natural finish to folded napkins.', q: 'napkin rings table' },
  ],

  // ------------------------------------------------------------------ Specialty Collections
  'specialty-collections': [
    { n: 'Curator Mixed Glaze Tableware Edit — 12 Pieces', m: 'stoneware', c: 'assorted', f: 'mixed glazes', pcs: 12, mrp: 5999, p: 4799, b: 'A curated mix of plates and bowls in four complementary glazes for an eclectic, collected look.', q: 'mixed ceramic plates' },
    { n: 'Atelier Signature Serving Collection — 4 Pieces', m: 'porcelain', c: 'white', f: 'gloss', ds: 'hand-drawn line', pcs: 4, mrp: 4999, p: 3999, b: 'A platter, two bowls and a jug linked by a single hand-drawn line motif.', q: 'white serveware table' },
  ],
  'minimalist-tableware': [
    { n: 'Pure Form Minimalist Dinner Set — 12 Pieces', m: 'porcelain', c: 'white', f: 'matte', pcs: 12, comp: [['Plate', 4], ['Side plate', 4], ['Bowl', 4]], sv: 4, mrp: 4999, p: 3999, b: 'Matte white porcelain in pared-back forms — nothing extra, nothing missing.', q: 'minimalist white plates' },
    { n: 'Monochrome Stacking Bowls Set of 4', m: 'stoneware', c: 'grey', f: 'matte', pcs: 4, mrp: 1999, p: 1599, b: 'Four stackable bowls in graduated greys.', q: 'minimal ceramic bowls' },
  ],
  'modern-ceramic-collections': [
    { n: 'Studio Pottery Plates Set of 4', m: 'stoneware', c: 'blue grey', f: 'reactive glaze', pcs: 4, dim: D(260), mrp: 2999, p: 2399, b: 'Studio-style plates with a pooling blue-grey reactive glaze.', q: 'handmade pottery plates' },
    { n: 'Geometric Relief Bowls Set of 4', m: 'ceramic', c: 'white', f: 'matte', ds: 'geometric relief', pcs: 4, mrp: 1999, p: 1599, b: 'Bowls with a crisp geometric relief that plays with light and shadow.', q: 'modern ceramic bowls' },
  ],
  'floral-crockery': [
    { n: 'Wildflower Meadow Dinner Set — 18 Pieces', m: 'porcelain', c: 'white', f: 'gloss', pa: 'floral', pcs: 18, sv: 6, mrp: 7999, p: 6499, b: 'Printed with delicate wildflowers around every rim — spring on the table all year round.', q: 'floral plates' },
    { n: 'Chintz Teacups Set of 4', m: 'bone_china', c: 'multicolour', f: 'gloss', pa: 'chintz', pcs: 8, comp: [['Cup', 4], ['Saucer', 4]], mrp: 2999, p: 2499, b: 'Four mismatched chintz teacups and saucers for a vintage tea party.', q: 'floral teacups' },
  ],
  'traditional-indian-tableware': [
    { n: 'Steel Thali Set — 6 Pieces', m: 'stainless_steel', c: 'silver', f: 'mirror polish', pcs: 6, comp: [['Thali', 1], ['Katori', 3], ['Glass', 1], ['Spoon', 1]], mrp: 1499, p: 1199, b: 'A classic thali with katoris, glass and spoon for a complete Indian meal.', q: 'indian thali' },
    { n: 'Brass Katori Set of 6', m: 'brass', c: 'brass', f: 'polished', pcs: 6, ml: 150, mrp: 2499, p: 1999, b: 'Six polished brass katoris for dal, sabzi and kheer.', q: 'brass bowls indian' },
  ],
  'luxury-dining-collections': [
    { n: 'Palais Gold Charger Plates Set of 6', m: 'glass', c: 'gold', f: 'metallic', ds: 'beaded rim', pcs: 6, dim: D(330), mrp: 5999, p: 4799, b: 'Gold charger plates with a beaded rim for grand, layered table settings.', q: 'gold charger plates' },
    { n: 'Noir Luxe Dinner Set — 24 Pieces', m: 'porcelain', c: 'black', f: 'gloss', ds: 'gold band', pcs: 24, sv: 6, mrp: 17999, p: 14499, b: 'Glossy black porcelain with a wide gold band for dramatic evening dining.', q: 'luxury table setting' },
  ],
  'everyday-dining-essentials': [
    { n: 'Everyday Essentials Dinner Set — 16 Pieces', m: 'stoneware', c: 'oat', f: 'satin', pcs: 16, sv: 4, mrp: 4999, p: 3999, b: 'Plates, bowls and mugs for four in a versatile oat glaze.', q: 'everyday dinnerware' },
    { n: 'Mix and Match Bowls Set of 6', m: 'ceramic', c: 'assorted', f: 'gloss', pcs: 6, mrp: 1799, p: 1449, b: 'Six bowls in six colours that work with any plate.', q: 'colorful bowls' },
  ],
  'premium-homeware-collections': [
    { n: 'Marble and Brass Serving Collection — 3 Pieces', m: 'other', ms: ['other', 'brass'], c: 'white and gold', f: 'polished', pcs: 3, mrp: 6999, p: 5799, b: 'A marble platter, bowl and cake stand trimmed in brass.', q: 'marble serving platter' },
    { n: 'Artisan Ceramic Home Collection — 4 Pieces', m: 'ceramic', c: 'ivory', f: 'matte', pcs: 4, mrp: 5999, p: 4799, b: 'A vase, bowl, tray and candle holder in a coordinated ivory matte.', q: 'ceramic home decor' },
  ],

  // ------------------------------------------------------------------ Children's Tableware
  'childrens-tableware': [
    { n: 'Little Explorer Mealtime Set — 4 Pieces', m: 'stoneware', c: 'multicolour', f: 'gloss', pa: 'animal print', pcs: 4, comp: [['Plate', 1], ['Bowl', 1], ['Cup', 1], ['Spoon', 1]], mrp: 1499, p: 1199, b: 'A plate, bowl, cup and spoon decorated with friendly animals.', q: 'kids plate animals' },
    { n: 'Rainbow Steel Mealtime Set — 3 Pieces', m: 'stainless_steel', c: 'rainbow', f: 'iridescent', pcs: 3, mrp: 1199, p: 949, b: 'A plate, bowl and tumbler in iridescent rainbow steel.', q: 'colorful kids tableware' },
  ],
  'childrens-plates': [
    { n: 'Divided Dino Plate', m: 'ceramic', c: 'green', f: 'gloss', pa: 'dinosaur', pcs: 1, dim: D(220), mrp: 599, p: 499, b: 'A divided plate with a dinosaur design that keeps foods separate.', q: 'kids divided plate' },
    { n: 'Steel Compartment Plate', m: 'stainless_steel', c: 'silver', f: 'mirror polish', pcs: 1, dim: D(240), mrp: 499, p: 419, b: 'A sturdy steel plate with three compartments.', q: 'child plate food' },
  ],
  'childrens-bowls': [
    { n: 'Bunny Ears Bowl', m: 'ceramic', c: 'white and pink', f: 'gloss', ds: 'bunny ears', pcs: 1, ml: 350, mrp: 499, p: 419, b: 'A small bowl with bunny-ear handles that are easy for little hands to hold.', q: 'kids bowl cute' },
    { n: 'Snack Bowls Set of 3', m: 'stainless_steel', c: 'assorted', f: 'powder coated', pcs: 3, ml: 250, mrp: 699, p: 579, b: 'Three brightly coloured snack bowls for fruit and snacks.', q: 'colorful snack bowls kids' },
  ],
  'childrens-cups': [
    { n: 'Animal Face Mug — 250 ml', m: 'ceramic', c: 'yellow', f: 'gloss', ds: 'lion face', pcs: 1, ml: 250, mrp: 449, p: 379, b: 'A small mug with a cheerful lion face for milk and juice.', q: 'kids mug animal' },
    { n: 'Steel Tumblers Set of 4', m: 'stainless_steel', c: 'assorted', f: 'powder coated', pcs: 4, ml: 200, mrp: 799, p: 649, b: 'Four colourful steel tumblers sized for children.', q: 'colorful cups' },
  ],
  'childrens-dining-sets': [
    { n: 'Under the Sea Dining Set — 3 Pieces', m: 'ceramic', c: 'blue', f: 'gloss', pa: 'sea creatures', pcs: 3, comp: [['Plate', 1], ['Bowl', 1], ['Mug', 1]], mrp: 1199, p: 949, b: 'A plate, bowl and mug decorated with whales, fish and octopuses.', q: 'kids dining set' },
    { n: 'Space Adventure Dining Set — 4 Pieces', m: 'ceramic', c: 'navy', f: 'gloss', pa: 'space', pcs: 4, comp: [['Plate', 1], ['Bowl', 1], ['Mug', 1], ['Spoon', 1]], mrp: 1299, p: 1049, b: 'Rockets and planets on a plate, bowl, mug and spoon for young astronauts.', q: 'children tableware' },
  ],
};

module.exports = { PRODUCTS };
