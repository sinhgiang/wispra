/*
 * Sample data for the Mind map design prototype (ticket T-0004).
 * Everything here is invented: a 2 h 38 min planning meeting of a fictional product team.
 *
 * The shapes mirror what the real build would store on a MeetingSession:
 *   - TRANSCRIPT: paragraph blocks built from MeetingSegment (id, startMs, text).
 *   - MAP: a tree where every node carries a segment range [from, to] (inclusive),
 *     so "Show in transcript" can reuse the chat panel's existing highlight.
 */
;(function () {
  const ms = (hms) => {
    const p = hms.split(':').map(Number)
    return ((p[0] * 60 + p[1]) * 60 + p[2]) * 1000
  }

  const SESSION = {
    title: 'Q4 Product Planning & Launch Review',
    createdAt: 'Mon, Sep 28, 2026 · 09:02',
    durationMs: ms('2:38:14'),
    summary:
      'A long planning session covering Q3 results, customer feedback, the Q4 roadmap, pricing, the Business tier launch and hiring. The team agreed on three bets for the quarter and a November 17 launch date.'
  }

  const blocks = [
    ['0:00:20', "Okay, let's get started, we have a lot to cover today. The plan is: Q3 numbers first, then what customers have been telling us, then we lock the Q4 roadmap, pricing, the launch plan, and we finish with hiring and budget. I'd like us to leave this room with decisions, not just discussion."],
    ['0:02:10', "So, revenue. We closed Q3 at four hundred and twelve thousand dollars, which is up eighteen percent on the previous quarter. Almost all of that growth came from the Team plan, the Solo plan was basically flat. Expansion inside existing accounts was stronger than new business."],
    ['0:07:45', "Activation is the number I'm less happy about. Forty-one percent of new signups finish their first project within a week, and our target was fifty. We moved it by two points over the quarter, so the small fixes we shipped are not enough on their own."],
    ['0:12:30', "Churn is better news. Monthly churn went from three point one percent down to two point six. The annual plan discount we introduced in July clearly helped, about a third of new Team customers picked annual, and those accounts almost never leave in the first six months."],
    ['0:17:05', "What slipped. The mobile app came out six weeks late, mostly because of the sync rewrite. And on integrations we promised five and shipped two. I think we were too optimistic about how much the two squads could carry in parallel."],
    ['0:21:40', "On support, ticket volume is up about thirty percent, which is more than customer growth. Median first response is now five hours. A lot of those tickets are the same onboarding questions over and over, so it connects to the activation problem."],
    ['0:24:30', "Moving to customer feedback. We ran fourteen interviews in September. The loudest theme by far is that onboarding is confusing. People sign up, land on an empty workspace, and they don't find the templates at all. Several of them said they only discovered templates weeks later by accident."],
    ['0:30:15', "From the larger accounts the message is different. They need single sign-on and an audit log before security will approve us. Tom, you have three deals blocked on exactly that, right? Yes, three deals, roughly ninety thousand in annual value, all waiting on SSO and audit log."],
    ['0:36:50', "Mobile is where we get the angriest feedback. There's no offline mode, so the app is useless on a plane or on a bad connection, and people say it loses their edits. Our store rating is sitting at three point four and most one-star reviews mention offline."],
    ['0:42:20', "It's not all bad. Customers keep praising how fast the product feels, and the weekly digest email gets mentioned unprompted in almost every interview. NPS went from thirty-eight to forty-four this quarter, so the core experience is working for people once they are in."],
    ['0:47:10', "On feature requests, calendar sync is still the top-voted item with two hundred and twelve votes. Second is recurring tasks, third is a public API for reporting. Calendar sync has been number one for three quarters in a row now."],
    ['0:51:00', "Right, roadmap. I want to propose a rule for Q4: three bets, maximum. We have two squads and eleven working weeks once you take out the holidays. Last quarter we tried to do six things and we finished three, so let's pick three and finish three."],
    ['0:57:30', "Bet one, in my view, is the onboarding redesign. A guided setup instead of the empty workspace, and templates as the very first thing you see. Linh already has sketches. The goal is simple: activation from forty-one percent to fifty by the end of the quarter."],
    ['1:04:40', "Bet two is SSO plus audit log, because that unlocks the enterprise deals. Daniel, how big is it? If we do SAML through our current auth provider instead of building it ourselves, I'd estimate five weeks for one squad, including the audit log, as long as we keep the first version of the log read-only."],
    ['1:11:15', "Bet three is where I expect disagreement: mobile offline. I'm worried about it. Full offline editing means solving sync conflicts properly and that's eight weeks at least, probably more. What if we cut scope and ship read-only offline first, so people can at least open their projects without a connection? That I can believe in for this quarter."],
    ['1:17:50', "Then calendar sync. I know it's the top request, but it doesn't fit as a fourth bet. My proposal is we defer the build to Q1 and only do a short discovery spike this quarter, one engineer for a week, so we start Q1 knowing which calendars and which direction of sync we support."],
    ['1:23:30', "Last thing on roadmap, tech debt. We keep twenty percent of capacity reserved, same as before. The one item that cannot wait is migrating the job queue, because the current one will not survive launch traffic. That has to land before the launch, not after."],
    ['1:28:20', "Pricing. Today the Team plan is twelve dollars per seat. The proposal is to raise it to fifteen for new customers only. We haven't changed the price in two years and the win-loss data says price is almost never the reason we lose a deal."],
    ['1:34:10', "And we add a new Business tier at twenty-four dollars per seat. That's where SSO and the audit log live, plus priority support with a four-hour response commitment. It gives the enterprise deals somewhere to land without custom contracts every time."],
    ['1:40:05', "For existing customers I want to be generous. Anyone on the Team plan today keeps their current price for twelve months. We announce it clearly in advance so nobody gets a surprise on their invoice. Everyone okay with twelve months? Yes. Good."],
    ['1:45:30', "The free plan is the part we don't agree on. Right now it allows three projects. Priya wants to keep three because it drives word of mouth, Tom wants to drop to two to push upgrades. Honestly we're arguing without data. Omar, can you pull how many free accounts actually use the third project?"],
    ['1:52:00', "Launch plan. I'd like to target November seventeenth for the Business tier launch. Before that a closed beta starting October twenty-sixth with ten customers, ideally including the three stalled deals so they can validate SSO with their own identity providers."],
    ['1:58:25', "For messaging, the line I keep coming back to is: built for teams that outgrew the basics. It speaks to the customers who started small with us and now need control and security. Priya will turn that into a proper positioning draft for next week."],
    ['2:04:40', "Channels: the launch email goes to our eighteen thousand users, we run a webinar the same week, and two partners offered co-marketing. Product Hunt is an open question. It brings attention, but mostly from small teams, and this launch is aimed at larger ones."],
    ['2:10:50', "Sales needs to be ready on day one. That means a demo script that actually shows SSO setup, and a pricing FAQ covering the questions about the increase and grandfathering. Tom will also re-engage the three stalled deals now and invite them to the beta."],
    ['2:16:20', "Risks. The big one is SSO slipping, because the whole launch depends on it. Second, the holiday code freeze starts December fifteenth, so if we miss November there's very little room. Let's put a go or no-go checkpoint on November tenth, one week before launch."],
    ['2:21:10', "Hiring. We approved two roles. One senior mobile engineer, because offline can't depend on a single person, and one support specialist to bring response times back down. Daniel will post the engineering role this week."],
    ['2:26:30', "Budget. Marketing asked for thirty-five thousand for the launch. Omar, your view? I can support thirty thousand as a cap, the webinar and partner work don't need the full amount. Agreed, thirty thousand. Separately we need an external contractor for the security review before SSO goes live, about eight thousand."],
    ['2:30:45', "On support tooling, two ideas: revamp the help centre so the onboarding questions are answered there, and trial an AI triage tool for incoming tickets. Both make sense, but nobody owns the help centre revamp yet, so we need to decide who does."],
    ['2:34:00', "Let me recap the decisions. Three bets: onboarding redesign, SSO with audit log, and mobile offline in a read-only first version. Calendar sync moves to Q1. Business tier at twenty-four dollars, existing customers keep their price for twelve months, launch on November seventeenth, marketing budget capped at thirty thousand."],
    ['2:36:10', "And actions. Maya writes the Q4 roadmap document by October fifth. Daniel delivers the SSO technical plan by October eighth. Linh has onboarding prototypes for October twelfth, which is also our next meeting. Priya drafts the positioning, Tom re-engages the stalled deals, Omar pulls the free plan usage data. Thanks everyone."]
  ]

  const TRANSCRIPT = blocks.map(([time, text], i) => ({ id: 'b' + (i + 1), startMs: ms(time), clock: clockAt(ms(time)), text }))

  function clockAt(offsetMs) {
    const total = 9 * 60 + 2 + Math.floor(offsetMs / 60000)
    const h = Math.floor(total / 60)
    const m = total % 60
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0')
  }

  // n(label, note, from, to, children, meta) — from/to are 1-based transcript block numbers.
  const n = (label, note, from, to, children, meta) => ({ label, note, from, to: to || from, children: children || [], meta })

  const topics = [
    {
      kind: 'topic', hue: 262,
      ...n('Q3 results review', 'Revenue and churn improved, activation missed its target, and delivery slipped on mobile and integrations.', 2, 6, [
        n('Revenue up 18%', 'Q3 closed at $412k, up 18% on the previous quarter.', 2, 2, [
          n('$412k for the quarter', 'Total Q3 revenue.', 2),
          n('Team plan drove the growth', 'The Solo plan was flat; expansion inside existing accounts beat new business.', 2)
        ]),
        n('Activation below target', '41% of new signups finish a first project within a week, against a target of 50%. Small fixes only moved it by two points.', 3),
        n('Churn down to 2.6%', 'Monthly churn fell from 3.1% to 2.6%.', 4, 4, [
          n('Annual plan discount helped', 'About a third of new Team customers chose annual, and those accounts rarely leave in the first six months.', 4)
        ]),
        n('What slipped', 'The team was too optimistic about what two squads could carry in parallel.', 5, 5, [
          n('Mobile app 6 weeks late', 'Mostly because of the sync rewrite.', 5),
          n('2 of 5 integrations shipped', 'Five were promised for the quarter.', 5)
        ]),
        n('Support load up 30%', 'Ticket volume grew faster than the customer base; median first response is now 5 hours. Many tickets repeat the same onboarding questions.', 6)
      ])
    },
    {
      kind: 'topic', hue: 232,
      ...n('Customer feedback', 'Fourteen interviews: onboarding confuses new users, enterprise buyers are blocked on security features, mobile needs offline.', 7, 11, [
        n('Onboarding is confusing', 'The loudest theme from 14 interviews in September.', 7, 7, [
          n('Empty workspace on first run', 'New users land on a blank workspace with no guidance.', 7),
          n('Templates are hard to find', 'Several customers found templates only weeks later, by accident.', 7)
        ]),
        n('Enterprise blockers', 'Larger accounts cannot pass security review without these.', 8, 8, [
          n('Single sign-on', 'Required before security teams approve the product.', 8),
          n('Audit log', 'Requested together with SSO.', 8),
          n('3 deals stalled, about $90k', 'Annual value waiting on SSO and audit log.', 8)
        ]),
        n('Mobile complaints', 'The angriest feedback comes from mobile users.', 9, 9, [
          n('No offline mode', 'The app is unusable on a plane or a bad connection, and users report lost edits.', 9),
          n('Store rating 3.4', 'Most one-star reviews mention offline.', 9)
        ]),
        n('What customers love', 'The core experience works once people are in.', 10, 10, [
          n('Speed', 'Praised in almost every interview.', 10),
          n('Weekly digest email', 'Mentioned unprompted by most customers.', 10),
          n('NPS 38 → 44', 'Up six points this quarter.', 10)
        ]),
        n('Top request: calendar sync', '212 votes, number one for three quarters in a row. Recurring tasks and a reporting API follow.', 11)
      ])
    },
    {
      kind: 'topic', hue: 205,
      ...n('Roadmap priorities', 'Three bets for the quarter, calendar sync deferred, and 20% of capacity kept for tech debt.', 12, 17, [
        n('Rule: three bets, maximum', 'Last quarter six things were started and three finished.', 12, 12, [
          n('2 squads, 11 working weeks', 'Capacity for Q4 after holidays.', 12)
        ]),
        n('Bet 1: Onboarding redesign', 'Replace the empty workspace with a guided first run.', 13, 13, [
          n('Guided setup', 'Step-by-step first run instead of a blank workspace.', 13),
          n('Templates shown first', 'Templates become the first thing a new user sees.', 13),
          n('Goal: activation 41% → 50%', 'Target for the end of the quarter.', 13)
        ]),
        n('Bet 2: SSO + audit log', 'Unlocks the stalled enterprise deals.', 14, 14, [
          n('SAML via current auth provider', 'Use the existing provider instead of building SSO in-house.', 14),
          n('Estimate: 5 weeks, one squad', 'Holds only if the first audit log is read-only.', 14)
        ]),
        n('Bet 3: Mobile offline', 'The most debated bet; scope was cut to make it fit the quarter.', 15, 15, [
          n('Sync conflicts are the risk', 'Full offline editing needs proper conflict handling.', 15),
          n('Full version: 8+ weeks', "Engineering's estimate for offline editing.", 15),
          n('Scope cut: read-only first', 'Ship the ability to open projects offline; editing comes later. This reduced scope is believed to fit within Q4.', 15)
        ]),
        n('Calendar sync deferred', 'Top request, but it does not fit as a fourth bet.', 16, 16, [
          n('Discovery spike only', 'One engineer for one week, to decide which calendars and sync direction.', 16),
          n('Build moves to Q1', 'Planned to start next quarter with the spike results.', 16)
        ]),
        n('Tech debt: 20% capacity', 'Same reservation as previous quarters.', 17, 17, [
          n('Migrate job queue before launch', 'The current queue will not survive launch traffic.', 17)
        ])
      ])
    },
    {
      kind: 'topic', hue: 172,
      ...n('Pricing & packaging', 'A price rise for new Team customers, a new Business tier, and protection for existing customers. The free plan limit stays open.', 18, 21, [
        n('Team plan: $12 → $15', 'First price change in two years; win-loss data shows price is rarely why deals are lost.', 18, 18, [
          n('New customers only', 'Existing customers are handled by the 12-month price lock.', 18)
        ]),
        n('New Business tier: $24', 'Gives enterprise deals a standard plan instead of custom contracts.', 19, 19, [
          n('SSO and audit log', 'The security features live in this tier.', 19),
          n('Priority support', 'Four-hour response commitment.', 19)
        ]),
        n('Price lock for 12 months', 'Current Team customers keep their price for a year, announced in advance.', 20),
        n('Free plan limit', 'No agreement; the team is arguing without data.', 21, 21, [
          n('Keep 3 projects', 'Marketing: the free plan drives word of mouth.', 21),
          n('Reduce to 2 projects', 'Sales: a tighter limit pushes upgrades.', 21)
        ])
      ])
    },
    {
      kind: 'topic', hue: 300,
      ...n('Launch plan', 'Business tier launches on November 17 after a closed beta; the main risk is SSO slipping.', 22, 26, [
        n('Timeline', 'Beta first, then public launch.', 22, 22, [
          n('Closed beta: Oct 26', 'Ten customers, ideally including the three stalled deals.', 22),
          n('Launch: Nov 17', 'Target date for the Business tier.', 22)
        ]),
        n('Messaging', 'Aimed at customers who started small and now need control and security.', 23, 23, [
          n('"Teams that outgrew the basics"', 'Working line for the positioning draft.', 23)
        ]),
        n('Channels', 'Email, webinar and partners are confirmed.', 24, 24, [
          n('Email to 18k users', 'Launch announcement to the whole user base.', 24),
          n('Webinar in launch week', 'Run the same week as the launch.', 24),
          n('Partner co-marketing', 'Two partners offered to take part.', 24)
        ]),
        n('Sales enablement', 'Sales must be ready on day one.', 25, 25, [
          n('Demo script with SSO setup', 'The demo must show SSO being configured.', 25),
          n('Pricing FAQ', 'Covers the price increase and the 12-month lock.', 25)
        ]),
        n('Risks', 'Little room to recover if November is missed.', 26, 26, [
          n('SSO slipping', 'The whole launch depends on it.', 26),
          n('Holiday freeze from Dec 15', 'Code freeze leaves almost no fallback window.', 26),
          n('Go / no-go on Nov 10', 'Checkpoint one week before launch.', 26)
        ])
      ])
    },
    {
      kind: 'topic', hue: 335,
      ...n('Hiring & budget', 'Two hires approved, launch marketing capped, and a contractor for the security review.', 27, 29, [
        n('Two roles approved', 'One for mobile, one for support.', 27, 27, [
          n('Senior mobile engineer', 'Offline work should not depend on one person.', 27),
          n('Support specialist', 'To bring response times back down.', 27)
        ]),
        n('Launch marketing budget', '$35k was requested; $30k was agreed as a cap.', 28),
        n('Security review contractor', 'External review before SSO goes live, about $8k.', 28),
        n('Support tooling', 'Two ideas to reduce repeated tickets.', 29, 29, [
          n('Help centre revamp', 'Answer the common onboarding questions there. No owner yet.', 29),
          n('AI triage trial', 'Trial a tool that sorts incoming tickets.', 29)
        ])
      ])
    }
  ]

  const outcomes = [
    {
      kind: 'decisions', hue: 150,
      ...n('Decisions', 'What the meeting agreed on.', 30, 30, [
        n('Three bets for Q4', 'Onboarding redesign, SSO with audit log, and mobile offline (read-only first).', 12, 15),
        n('Calendar sync moves to Q1', 'Only a discovery spike this quarter.', 16),
        n('Business tier at $24 per seat', 'Includes SSO, audit log and priority support.', 19),
        n('12-month price lock', 'Existing Team customers keep their current price for a year.', 20),
        n('Launch on November 17', 'Closed beta from October 26; go / no-go on November 10.', 22),
        n('Marketing budget capped at $30k', '$35k was requested.', 28)
      ])
    },
    {
      kind: 'actions', hue: 65,
      ...n('Action items', 'Who does what after the meeting.', 31, 31, [
        n('Write the Q4 roadmap document', 'Capture the three bets and the deferred items.', 31, 31, [], { owner: 'Maya', due: 'Oct 5' }),
        n('SSO technical plan', 'SAML through the current auth provider, with a read-only audit log.', 14, 14, [], { owner: 'Daniel', due: 'Oct 8' }),
        n('Onboarding prototypes', 'Guided setup with templates first, for the next meeting.', 13, 13, [], { owner: 'Linh', due: 'Oct 12' }),
        n('Positioning draft', 'Built around "teams that outgrew the basics".', 23, 23, [], { owner: 'Priya', due: 'next week' }),
        n('Re-engage 3 stalled deals', 'Invite them to the closed beta.', 25, 25, [], { owner: 'Tom' }),
        n('Free plan usage data', 'How many free accounts use the third project.', 21, 21, [], { owner: 'Omar' }),
        n('Post the mobile engineer role', 'Senior mobile engineer, this week.', 27, 27, [], { owner: 'Daniel', due: 'this week' })
      ])
    },
    {
      kind: 'questions', hue: 28,
      ...n('Open questions', 'Raised but not settled.', 21, 29, [
        n('Lower the free plan limit?', 'Three projects or two; waiting for usage data.', 21),
        n('Launch on Product Hunt?', 'It brings attention, but mostly from small teams.', 24),
        n('When does full offline editing ship?', 'Only the read-only version is planned for Q4.', 15),
        n('Who owns the help centre revamp?', 'No owner was named.', 29)
      ])
    }
  ]

  window.SAMPLE = { SESSION, TRANSCRIPT, MAP: { topics, outcomes } }
})()
