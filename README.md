# FCT - Future Cash Timeline

A financial dashboard application that tracks your current and future cash positions, calculates cash flow, and manages upcoming bills.

## Features

- **Cash Flow Analysis**: View your cash position day by day for the next 90 days
- **Timeline Scrubber**: Navigate through the future timeline to see how your balance changes
- **Chart.js Integration**: Visual representation of cash balance trends
- **Bill Management**: Track upcoming and overdue bills with status indicators
- **Recurring Bill Support**: Automatic calculation of recurring bills

## Tech Stack

### Backend (Node.js + Express + TypeScript)
- **Express**: Web server framework
- **TypeScript**: Type safety and improved development experience
- **@notionhq/client**: Integration with Notion database for bills
- **date-fns**: Date manipulation and formatting
- **CORS**: Cross-origin resource sharing
- **Axios**: HTTP client

### Frontend (React + TypeScript)
- **React 18**: UI framework
- **TypeScript**: Type safety
- **Chart.js**: Interactive charts for cash flow visualization
- **Tailwind CSS**: Utility-first CSS framework
- **date-fns**: Date handling and formatting
- **Axios**: API calls

## Project Structure

```
fct/
├── backend/
│   ├── src/
│   │   ├── index.ts              # Express server entry point
│   │   ├── routes/
│   │   │   └── cashflow.ts      # Cash flow API routes
│   │   ├── services/
│   │   │   ├── notion.ts         # Notion API integration
│   │   │   └── cashflow.ts      # Cash flow calculations
│   │   ├── types/
│   │   │   ├── notion.d.ts      # Notion types
│   │   │   └── index.d.ts       # API response types
│   │   ├── utils/
│   │   │   └── date.ts          # Date utility functions
│   │   └── middleware/
│   │       └── auth.ts          # Authentication middleware
│   └── .env.example             # Environment variables template
├── frontend/
│   ├── src/
│   │   ├── components/
│   │   │   ├── TimelineScrubber.tsx  # Date navigation component
│   │   │   ├── CashFlowChart.tsx     # Chart.js line chart
│   │   │   ├── BillList.tsx          # Bill display component
│   │   │   └── Dashboard.tsx         # Main dashboard
│   │   ├── services/
│   │   │   └── api.ts               # Axios configuration
│   │   ├── types/
│   │   │   └── index.ts             # TypeScript types
│   │   ├── App.tsx                  # Main app component
│   │   └── main.tsx                 # Entry point
│   └── .env.example                 # Environment variables template
├── docker-compose.yml              # Multi-container setup
└── README.md                       # This file
```