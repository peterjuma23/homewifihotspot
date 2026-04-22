# FastConnect Internet - WiFi Billing System

A complete WiFi billing system with M-Pesa STK Push integration, voucher system, and real-time admin dashboard.

## Features

- **Customer Portal**: 6 internet plans (2h to Monthly)
- **M-Pesa STK Push**: Direct to phone payment
- **Voucher System**: Prepaid voucher redemption (Demo: FC-DEMO-2024)
- **Admin Dashboard**: User management, sales reports, voucher generation
- **Real-time Updates**: WebSocket for live notifications
- **Responsive Design**: Works on all screen sizes

## Deployment on Render.com (Free Tier)

### Step 1: Database Setup
1. Create a free MySQL database on [Clever Cloud](https://www.clever-cloud.com) or [Aiven](https://aiven.io)
2. Run the `schema.sql` script on your database

### Step 2: Environment Variables
Add these in Render Dashboard:

| Variable | Value |
|----------|-------|
| `DB_HOST` | Your MySQL host |
| `DB_USER` | Database username |
| `DB_PASSWORD` | Database password |
| `DB_NAME` | fastconnect_db |
| `JWT_SECRET` | Any random string |
| `M_PESA_CONSUMER_KEY` | (Optional) Your M-Pesa key |
| `M_PESA_CONSUMER_SECRET` | (Optional) Your M-Pesa secret |

### Step 3: Deploy
1. Push code to GitHub
2. On Render: New Web Service → Connect repo
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Free tier works!

## Default Credentials

- **Admin**: admin / Admin@FastConnect2024!
- **Demo Voucher**: FC-DEMO-2024

## Local Development

```bash
npm install
node server.js
# Visit http://localhost:3000