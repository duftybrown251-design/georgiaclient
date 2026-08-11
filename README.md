# Kia Ora Client Hub — Stage 1 Functional CRM

This version keeps the polished CRM design and adds working client management.

## Works immediately (Demo Mode)
- Dashboard
- Search clients
- Add/edit clients
- Open client profiles
- Add notes
- Add tasks
- Complete tasks
- Local browser persistence
- PWA install support

## Enable cloud data with Supabase
1. Create a Supabase project.
2. Run `supabase.sql` in the Supabase SQL Editor.
3. Copy your project URL and **anon/public** key into `config.js`:

```js
window.CLIENT_HUB_CONFIG = {
  supabaseUrl: 'https://YOUR-PROJECT.supabase.co',
  supabaseAnonKey: 'YOUR-ANON-KEY',
  appName: 'Kia Ora Client Hub'
};
```

4. Serve the folder from HTTPS or a local web server.
5. Open Settings and create an account.

The app uses Supabase Row Level Security so each signed-in user only sees their own rows. Never put a Supabase service-role key in `config.js` or in the browser.

## Run locally
Use any static web server, for example:

```bash
npx serve .
```

Then open the URL shown in the terminal.

## Next stage
Add Google Workspace and Microsoft 365 OAuth so emails and calendar meetings can be automatically matched to each client.
