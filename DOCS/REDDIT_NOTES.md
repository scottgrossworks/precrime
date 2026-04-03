 1. Go to https://www.reddit.com/prefs/apps
  2. Create app → type script

name: precrime

  3. Note the client ID (under app name) and secret
  4. Add to .env in your PRECRIME root:
  CLIENT_ID=your_client_id
  CLIENT_SECRET=your_client_secret
  USER_AGENT=precrime:v1.0 (by /u/your_username)
  REDDIT_USERNAME=your_username
  REDDIT_PASSWORD=your_password