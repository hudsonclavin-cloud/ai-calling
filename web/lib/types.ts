export type CallStatus = "in_progress" | "completed";

export interface TranscriptEntry {
  role: "caller" | "assistant";
  text: string;
  ts: string;
}

export interface CallRecord {
  id: string;
  callSid: string;
  firmId: string;
  fromPhone: string;
  leadId: string;
  status: CallStatus;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  outcome: string;
  collected: {
    full_name?: string;
    callback_number?: string;
    practice_area?: string;
    case_summary?: string;
  };
  transcript: TranscriptEntry[];
}

export interface TimelineEvent {
  ts: string;
  type: string;
  detail: string;
}

export interface LeadSummary {
  id: string;
  firmId: string;
  fromPhone: string;
  full_name: string;
  callback_number: string;
  practice_area: string;
  case_summary: string;
  caller_type: string;
  status: string;
  lastCallSid: string;
  createdAt: string;
  updatedAt: string;
}

export interface LeadDetail {
  id: string;
  firmId: string;
  fromPhone: string;
  full_name: string;
  callback_number: string;
  practice_area: string;
  case_summary: string;
  caller_type: string;
  status: string;
  lastCallSid: string;
  createdAt: string;
  updatedAt: string;
  transcript: TranscriptEntry[];
  timeline: TimelineEvent[];
}

export interface FirmSettings {
  id: string;
  name: string;
  ava_name: string;
  tone: string;
  opening: string;
  closing: string;
  practice_areas: string[];
  required_fields: string[];
  question_overrides: Record<string, string>;
  acknowledgments: string[];
  max_questions: number;
  max_reprompts: number;
  office_hours: string;
  disclaimer: string;
  intake_rules: string;
  notification_email: string;
  notification_phone: string;
  stripe_customer_id?: string;
  stripe_subscription_id?: string;
  billing_status?: string;
}
