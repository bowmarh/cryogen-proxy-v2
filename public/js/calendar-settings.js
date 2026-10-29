'use strict';

window.CryogenCalendarSettings = (() => {
  let calendar = null;
  let message = '';

  function render(esc) {
    const btn = 'padding:7px 14px;font-size:12px;font-weight:700;border-radius:8px;cursor:pointer;background:rgba(0,212,255,0.12);color:#00D4FF;border:1px solid rgba(0,212,255,0.4)';
    const ghost = 'padding:6px 12px;font-size:12px;border-radius:8px;cursor:pointer;background:none;color:#9ca3af;border:1px solid rgba(255,255,255,0.15)';
    const body = !calendar
      ? `<div role="alert" style="font-size:13px;color:#f87171;margin-bottom:10px">Could not load your calendar settings: ${esc(message || 'Please try again.')}</div><button onclick="fillCalSlots()" style="${btn}">Try again</button>`
      : !calendar.on
      ? `<div style="font-size:13px;color:#9ca3af;margin-bottom:10px">Put your races and rides in your own calendar (Google, Apple or Outlook). It updates by itself: your next ${calendar.windowDays / 7} weeks, with the things waiting for your answer marked ❓.</div><button onclick="calAct('POST',{},'Calendar link created.')" style="${btn}">Create my calendar link</button>`
      : `<div style="font-size:13px;color:#10B981;margin-bottom:8px">✅ Your calendar link is ready. Add it once and it stays up to date.</div>
    <input readonly value="${esc(calendar.url)}" onclick="this.select()" style="width:100%;box-sizing:border-box;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:8px 12px;color:white;font-size:12px"/>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px"><button onclick="calCopy()" style="${btn}">📋 Copy link</button><a href="${esc(calendar.url.replace(/^https?:/,'webcal:'))}" style="${btn};text-decoration:none">Add to my calendar</a><button onclick="if(confirm('Make a new link? The old one stops working.'))calAct('POST',{reset:true},'New link created. Add it to your calendar again.')" style="${ghost}">New link</button><button onclick="if(confirm('Switch the calendar off? The link stops working.'))calAct('POST/remove',{},'Calendar switched off.')" style="${ghost}">Switch off</button></div>
    <div style="font-size:11px;color:#6b7280;margin-top:8px">Keep the link to yourself: anyone who has it can see your schedule. In Google Calendar choose Other calendars → From URL and paste it.</div>`;
    document.querySelectorAll('.cal-slot').forEach(el => {
      el.innerHTML = `<div class="card" style="padding:14px 16px"><div style="font-weight:800;margin-bottom:6px">📅 My calendar</div>${body}${calendar && message ? `<div role="status" style="font-size:12px;margin-top:8px;color:${message.startsWith('✓') ? '#10B981' : '#f87171'}">${esc(message)}</div>` : ''}</div>`;
    });
  }

  async function fill(call, esc) {
    if (!document.querySelector('.cal-slot')) return;
    if (!calendar) {
      try {
        calendar = await call('GET', '/api/me/calendar');
        message = '';
      } catch (error) {
        message = error.message;
      }
    }
    render(esc);
  }

  async function act(how, body, okMessage, call, esc) {
    message = '';
    try {
      calendar = await call('POST', how === 'POST/remove' ? '/api/me/calendar/remove' : '/api/me/calendar', body);
      if (!calendar.on) calendar = { on: false, url: null, windowDays: 28 };
      message = `✓ ${okMessage}`;
    } catch (error) {
      message = error.message;
    }
    render(esc);
  }

  async function copy(esc) {
    try {
      await navigator.clipboard.writeText(calendar.url);
      message = '✓ Link copied.';
    } catch (error) {
      message = 'Select the link and copy it.';
    }
    render(esc);
  }

  return { fill, render, act, copy };
})();
