# InterServer DirectAdmin / cPanel Deployment

1. **Database Migration (Supabase)**:
   - Before deploying, go to your Supabase Project dashboard -> **SQL Editor**.
   - Execute the migration file located in `supabase/migrations/001_monthly_cycles.sql`.
   - Ensure the query executes with zero errors.

2. **Create / Configure Node.js Application**:
   - Node.js version: **20.x LTS** (or supported LTS >= 18.18)
   - Mode: **Production**
   - Application root: `bazar-app` (or your domain directory)
   - Application URL: `bazar.dxel.net`
   - Startup file: `server.js`

3. **Deploy Project Files**:
   - Upload/extract the project files into the application root directory so `package.json`, `server.js`, `app`, and `lib` are directly at the root.

4. **Install Dependencies & Build**:
   - In DirectAdmin/cPanel Terminal or Node.js manager:
     ```bash
     npm install
     npm run build
     ```

5. **Environment Variables**:
   Add the following variables in the Node.js selector or `.env.local`:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` *(Admin service role key from Supabase Project Settings -> API -> `service_role`)*
   - `GOOGLE_SHEET_ID`
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `GOOGLE_PRIVATE_KEY`
   - `GOOGLE_SHEETS_RANGE`

6. **Restart Application**:
   - Click **Restart** in the Node.js application management panel.
