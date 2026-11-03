'use strict';
const { boot } = require('./src/boot');

const PORT = Number(process.env.PORT) || 3000;

boot().then((app) => {
  app.listen(PORT, () => {
    console.log(`Crackers Cart running on http://localhost:${PORT}`);
    console.log(`Admin panel:            http://localhost:${PORT}/admin`);
  });
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
