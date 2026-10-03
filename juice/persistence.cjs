/* Xander local lab patch. Never used for third-party applications. */
const fs = require('node:fs');
const path = '/juice-shop/data/xander-persistence.json';
const cache = require('/juice-shop/build/data/datacache.js');
const { reviewsCollection, ordersCollection } = require('/juice-shop/build/data/mongodb.js');
const modelNames = { challenges:'Challenge', users:'User', products:'Product', feedback:'Feedback', baskets:'Basket', basketItems:'BasketItem', complaints:'Complaint' };
function atomic(data) { fs.writeFileSync(path+'.tmp', JSON.stringify(data)); fs.renameSync(path+'.tmp',path); }
module.exports = async (sequelize, seed) => {
  let saved;
  if(fs.existsSync(path)) saved = JSON.parse(fs.readFileSync(path,'utf8'));
  if(saved) {
    await sequelize.sync({force:false});
    for(const [group,model] of Object.entries(modelNames)) {
      for(const [key,id] of Object.entries(saved.cache[group] || {})) {
        const row = await sequelize.models[model].findByPk(id, {paranoid:false});
        if(row) cache[group][key] = row;
      }
    }
    // Restore original seeded references, including soft-deleted challenge users.
    const seeds = await require('/juice-shop/build/data/staticData.js').loadStaticUserData();
    const config = require('/juice-shop/node_modules/config');
    for(const seed of seeds) {
      const email = seed.customDomain ? seed.email : `${seed.email}@${config.get('application.domain')}`;
      const row = await sequelize.models.User.findOne({where:{email},paranoid:false});
      if(row) cache.users[seed.key] = row;
    }
    // Rebuild seed object references from retained rows, including soft-deleted products.
    // A legacy snapshot can omit these keys; do not reseed or disable route checks.
    for (const product of config.get('products')) {
      const key = product.useForChristmasSpecialChallenge ? 'christmasSpecial' : product.urlForProductTamperingChallenge ? 'osaft' : null;
      if (!key) continue;
      const row = await sequelize.models.Product.findOne({ where: { name: product.name }, paranoid: false });
      if (!row) throw new Error('Retained seed product reference is missing; restore database backup instead of destructive reseeding.');
      cache.products[key] = row;
    }
    cache.setRetrieveBlueprintChallengeFile(saved.blueprint || null);
    for(const row of saved.reviews || []) await reviewsCollection.insert(row);
    for(const row of saved.orders || []) await ordersCollection.insert(row);
    console.log('[Xander local lab] Preserved SQLite restored; no destructive seed reset.');
  } else {
    await sequelize.sync({force:true});
    await seed();
  }
  let busy=false;
  async function snapshot() {
    if(busy) return; busy=true;
    try {
      const ids = {};
      for(const group of Object.keys(modelNames)) ids[group] = Object.fromEntries(Object.entries(cache[group]).map(([key,row])=>[key,row.id]));
      atomic({format:1, cache:ids, blueprint:cache.retrieveBlueprintChallengeFile, reviews:await reviewsCollection.find({}), orders:await ordersCollection.find({})});
    } catch(error) { console.error('[Xander persistence]',error.message); } finally {busy=false;}
  }
  await snapshot();
  setInterval(snapshot, 2000).unref();
};
