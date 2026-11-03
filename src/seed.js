'use strict';
const { tx } = require('./db');

/** Adds a small sample catalog the first time the app starts with an empty database. */
function seedDemo(db) {
  if (db.prepare('SELECT COUNT(*) AS n FROM items').get().n > 0) return;
  if (db.prepare('SELECT COUNT(*) AS n FROM categories').get().n > 0) return;
  const catalog = {
    'Sparklers': [['10 cm Sparklers', 'box', 60, 120, 40], ['30 cm Colour Sparklers', 'box', 180, 360, 25]],
    'Flower Pots': [['Flower Pot Small', 'box', 150, 300, 30], ['Flower Pot Deluxe', 'box', 320, 640, 12]],
    'Ground Chakkars': [['Ground Chakkar Big', 'box', 140, 280, 35], ['Ground Chakkar Deluxe', 'box', 260, 520, 4]],
    'Rockets & Aerial': [['Baby Rocket', 'box', 120, 240, 20], ['Colour Rocket', 'box', 300, 600, 10], ['12 Shot Multicolour', 'piece', 450, 900, 8]],
    'Kids Special': [['Pencil Crackers', 'box', 90, 180, 50], ['Snake Tablets', 'box', 40, 80, 60]],
  };
  tx(db, () => {
    const addCat = db.prepare('INSERT INTO categories (name, sort_order) VALUES (?, ?)');
    const addItem = db.prepare('INSERT INTO items (name, category_id, unit, price, mrp, stock) VALUES (?, ?, ?, ?, ?, ?)');
    Object.entries(catalog).forEach(([cat, items], i) => {
      const cid = Number(addCat.run(cat, i).lastInsertRowid);
      for (const [name, unit, price, mrp, stock] of items) addItem.run(name, cid, unit, price * 100, mrp * 100, stock);
    });
    db.prepare(`INSERT INTO discounts (name, type, value, min_order, code) VALUES
      ('Festival offer', 'percent', 5, 100000, NULL),
      ('Big basket', 'percent', 10, 300000, NULL),
      ('Welcome coupon', 'flat', 5000, 50000, 'WELCOME50')`).run();
  });
}

module.exports = { seedDemo };
