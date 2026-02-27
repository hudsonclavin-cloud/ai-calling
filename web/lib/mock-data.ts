import type { CallRecord, FirmSettings, LeadDetail, LeadSummary } from "@/lib/types";

export const mockCalls: CallRecord[] = [
  {
    id: "call-1001",
    time: "2026-02-26T08:14:00.000Z",
    caller: "Maya Johnson",
    practiceArea: "Personal Injury",
    status: "answered",
    duration: "08:41",
    outcome: "Booked consultation",
    leadId: "lead-3001",
  },
  {
    id: "call-1002",
    time: "2026-02-26T09:22:00.000Z",
    caller: "Carlos Ruiz",
    practiceArea: "Family Law",
    status: "missed",
    duration: "00:00",
    outcome: "Left voicemail",
    leadId: "lead-3002",
  },
  {
    id: "call-1003",
    time: "2026-02-26T10:05:00.000Z",
    caller: "Priya Patel",
    practiceArea: "Employment",
    status: "voicemail",
    duration: "01:48",
    outcome: "Requested callback",
    leadId: "lead-3003",
  },
  {
    id: "call-1004",
    time: "2026-02-26T11:37:00.000Z",
    caller: "Derek Nguyen",
    practiceArea: "Estate Planning",
    status: "answered",
    duration: "06:12",
    outcome: "Needs document review",
    leadId: "lead-3004",
  },
  {
    id: "call-1005",
    time: "2026-02-26T12:11:00.000Z",
    caller: "Allison Reed",
    practiceArea: "Immigration",
    status: "answered",
    duration: "09:09",
    outcome: "Booked consultation",
    leadId: "lead-3005",
  },
];

export const mockLeads: LeadSummary[] = [
  {
    id: "lead-3001",
    caller: "Maya Johnson",
    practiceArea: "Personal Injury",
    status: "Consult booked",
    lastContactAt: "2026-02-26T08:14:00.000Z",
  },
  {
    id: "lead-3002",
    caller: "Carlos Ruiz",
    practiceArea: "Family Law",
    status: "Awaiting callback",
    lastContactAt: "2026-02-26T09:22:00.000Z",
  },
  {
    id: "lead-3003",
    caller: "Priya Patel",
    practiceArea: "Employment",
    status: "New lead",
    lastContactAt: "2026-02-26T10:05:00.000Z",
  },
];

export const mockLeadDetails: Record<string, LeadDetail> = {
  "lead-3001": {
    id: "lead-3001",
    caller: "Maya Johnson",
    phone: "+1 (415) 555-0124",
    email: "maya.johnson@example.com",
    practiceArea: "Personal Injury",
    status: "Consult booked",
    summary:
      "Caller described a rear-end collision and soft tissue injury. She has an active police report and treatment records.",
    transcript:
      "Agent: Thanks for calling Redwood Legal. What happened?\nCaller: I was rear-ended last week and my neck pain is getting worse.\nAgent: Did law enforcement respond?\nCaller: Yes, and I also visited urgent care.",
    suggestedNextAction: "Send intake packet and request accident report before consultation.",
    timeline: [
      {
        id: "evt-1",
        timestamp: "2026-02-26T08:14:00.000Z",
        type: "Call Started",
        description: "Inbound call routed to AI intake assistant.",
      },
      {
        id: "evt-2",
        timestamp: "2026-02-26T08:18:00.000Z",
        type: "Qualification",
        description: "Potential injury claim identified and urgency tagged medium.",
      },
      {
        id: "evt-3",
        timestamp: "2026-02-26T08:21:00.000Z",
        type: "Booked",
        description: "Consultation booked for 2026-02-27 at 10:30 AM.",
      },
    ],
  },
};

export const defaultLeadDetail = (id: string): LeadDetail => ({
  id,
  caller: "Unknown Lead",
  phone: "N/A",
  email: "N/A",
  practiceArea: "General",
  status: "New",
  summary: "Lead details will populate once the backend endpoint is available.",
  transcript: "No transcript available.",
  suggestedNextAction: "Review the lead and assign owner.",
  timeline: [
    {
      id: "evt-default",
      timestamp: new Date().toISOString(),
      type: "Lead Created",
      description: "Created from mock fallback data.",
    },
  ],
});

export const mockSettings: FirmSettings = {
  firmName: "Redwood Legal Group",
  practiceAreas: ["Personal Injury", "Family Law", "Employment"],
  officeHours: "Mon-Fri 8:00 AM - 6:00 PM",
  intakeRules:
    "Escalate high-risk matters immediately. Capture conflict-check details before scheduling consultations.",
  disclaimers:
    "Information collected is for intake purposes only and does not establish an attorney-client relationship.",
  escalationPhone: "+1 (415) 555-0199",
  escalationEmail: "intake-escalations@redwoodlegal.com",
};
