export enum AlertLevel {
  INFO = 'INFO',
  WARNING = 'WARNING',
  ERROR = 'ERROR',
  CRITICAL = 'CRITICAL',
}

export interface Alert {
  level: AlertLevel;
  title: string;
  message: string;
  metadata?: Record<string, any>;
}

export async function sendAlert(alert: Alert) {
  // Implement your alerting system (Slack, Email, SMS, etc.)
  console.log(`[ALERT] ${alert.level}: ${alert.title} - ${alert.message}`);
  
  // Example: Send to Slack
  // await sendSlackMessage({
  //   text: `*${alert.level}*: ${alert.title}\n${alert.message}`,
  //   attachments: [{ text: JSON.stringify(alert.metadata, null, 2) }],
  // });
}