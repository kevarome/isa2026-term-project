export const syntheticTickets = [
  {
    id: 'outage', style: 'plain', department: 'technical', urgency: 'high',
    message: 'My internet has been down since this morning, and I need the connection to work from home.'
  },
  {
    id: 'outage', style: 'brief', department: 'technical', urgency: 'high',
    message: 'Internet fully down since AM. No backup. Working now.'
  },
  {
    id: 'outage', style: 'conversational', department: 'technical', urgency: 'high',
    message: 'Hey, the whole internet went out this morning. I still have no connection and I’m supposed to be working.'
  },
  {
    id: 'duplicate-charge', style: 'plain', department: 'billing', urgency: 'medium',
    message: 'My latest internet bill shows the monthly charge twice. Could someone review the duplicate payment?'
  },
  {
    id: 'duplicate-charge', style: 'brief', department: 'billing', urgency: 'medium',
    message: 'Monthly internet fee charged twice. Need billing to fix.'
  },
  {
    id: 'duplicate-charge', style: 'conversational', department: 'billing', urgency: 'medium',
    message: 'Looks like you took out two payments for this month’s internet bill. Can you check what happened?'
  },
  {
    id: 'password-reset', style: 'plain', department: 'account', urgency: 'medium',
    message: 'I cannot sign in to my NorthLink account because the password reset email never arrives.'
  },
  {
    id: 'password-reset', style: 'brief', department: 'account', urgency: 'medium',
    message: 'Locked out of my NorthLink account. No password reset email.'
  },
  {
    id: 'password-reset', style: 'conversational', department: 'account', urgency: 'medium',
    message: 'Hey, I hit forgot password a few times but no email came through, so I still can’t get into my NorthLink account.'
  },
  {
    id: 'plan-inquiry', style: 'plain', department: 'general', urgency: 'low',
    message: 'What residential internet plans are available? I am comparing options before signing up.'
  },
  {
    id: 'plan-inquiry', style: 'brief', department: 'general', urgency: 'low',
    message: 'Just comparing plans. What home internet packages do you offer?'
  },
  {
    id: 'plan-inquiry', style: 'conversational', department: 'general', urgency: 'low',
    message: 'Hey! I’m shopping around for home internet and wondered what your packages look like.'
  }
];

export function fixtureResponse(department, urgency, confidence = 0.94) {
  return {
    answers: {
      department: { type: 'choice', choice: department, confidence },
      urgency: { type: 'choice', choice: urgency, confidence }
    }
  };
}
