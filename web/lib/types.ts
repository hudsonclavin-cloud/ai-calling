export type CallStatus = "answered" | "missed" | "voicemail";

export interface CallRecord {
  id: string;
  time: string;
  caller: string;
  practiceArea: string;
  status: CallStatus;
  duration: string;
  outcome: string;
  leadId?: string;
}

export interface TimelineEvent {
  id: string;
  timestamp: string;
  type: string;
  description: string;
}

export interface LeadSummary {
  id: string;
  caller: string;
  practiceArea: string;
  status: string;
  lastContactAt: string;
}

export interface LeadDetail {
  id: string;
  caller: string;
  phone: string;
  email: string;
  practiceArea: string;
  status: string;
  summary: string;
  transcript: string;
  suggestedNextAction: string;
  timeline: TimelineEvent[];
}

export interface FirmSettings {
  firmName: string;
  practiceAreas: string[];
  officeHours: string;
  intakeRules: string;
  disclaimers: string;
  escalationPhone: string;
  escalationEmail: string;
}
