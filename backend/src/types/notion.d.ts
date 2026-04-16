export interface NotionPage {
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