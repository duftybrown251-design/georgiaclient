# Kia Ora Client Hub - Static Demo

This version is a Vercel-safe static PWA. It works in demo mode without Supabase.

Working now:
- Add and edit clients
- Add notes with a mobile-friendly form
- Add tasks with a due date
- Mark tasks complete
- Search clients
- Browser persistence via localStorage
- Dashboard and client detail views

Important: deploy all files in this folder to the repository root. Do not include server.js or package.json in the static deployment.

The service worker cache key is versioned so the browser will refresh the new files after deployment.
