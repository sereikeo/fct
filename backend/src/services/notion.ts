import { Client } from '@notionhq/client';

const notion = new Client({ auth: process.env.NOTION_SECRET });

interface NotionPage {
  properties: {
    Name: { title: { text: { content: string } } } | undefined;
    Amount: { number: number } | undefined;
    DueDate: { start: string } | undefined;
    Recurring: { rich_text: { text: { content: string } }[] | undefined };
  };
  id: string;
}

export interface NotionBill {
  id: string;
  name: string;
  amount: number;
  dueDate: Date;
  recurring: boolean;
  recurringFrequency: string | null;
}

export async function getNotionBills(): Promise<NotionBill[]> {
  try {
    const response = await notion.databases.query({
      database_id: process.env.NOTION_DB_ID,
      filter: {
        property: 'Status',
        status: {
          equals: 'active'
        }
      }
    });

    return response.results.map((page: NotionPage) => ({
      id: page.id,
      name: page.properties.Name?.title?.[0].text.content || 'Unknown',
      amount: page.properties.Amount?.number || 0,
      dueDate: new Date(page.properties.DueDate?.start || new Date().toISOString()),
      recurring: page.properties.Recurring?.rich_text?.[0]?.text.content === 'yes',
      recurringFrequency: page.properties.Recurring?.rich_text?.[1]?.text?.content || null
    }));
  } catch (error) {
    console.error('Error fetching bills from Notion:', error);
    return [];
  }
}