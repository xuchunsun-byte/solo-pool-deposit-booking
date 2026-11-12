import { dueReminders, markReminderSent, getTechById } from "./db.js";
import { reminderEmail, sendEmail } from "./mailer.js";
import { whenLabel } from "./calendar.js";

export async function processReminders(cfg) {
  const due = dueReminders();
  const results = [];
  for (const booking of due) {
    const tech = getTechById(booking.tech_id);
    if (!tech) continue;
    const msg = reminderEmail({
      customerName: booking.customer_name,
      businessName: tech.business_name,
      serviceName: tech.service_name,
      whenLabel: whenLabel(booking, tech),
      serviceArea: tech.service_area,
      cancelPolicy: tech.cancel_policy,
    });
    try {
      const sent = await sendEmail(cfg, { to: booking.customer_email, ...msg });
      markReminderSent(booking.id);
      results.push({ id: booking.id, ok: true, provider: sent.provider });
    } catch (err) {
      results.push({ id: booking.id, ok: false, error: err.message });
    }
  }
  return results;
}

export function startReminderLoop(cfg, intervalMs = 60_000) {
  const tick = () => {
    processReminders(cfg).catch((err) => console.error("[reminders]", err));
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}
