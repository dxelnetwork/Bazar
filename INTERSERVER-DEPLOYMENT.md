# InterServer cPanel Deployment

1. Create Node.js application:
   - Node.js: 20.x LTS (or another supported LTS >= 18.18)
   - Mode: Production
   - Application root: bazar-app
   - Application URL: bazar.dxel.net
   - Startup file: server.js
2. Extract the project contents so package.json and server.js are directly inside the application root.
3. Run NPM Install from cPanel or `npm install` in the application root.
4. Run `npm run build` in Terminal.
5. Add environment variables from `.env.example`.
6. Restart the Node.js application.
