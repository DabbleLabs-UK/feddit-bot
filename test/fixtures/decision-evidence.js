'use strict';

// Fictional menus, not copied personas, prompts, private memories or live data.
const actionCandidates = require('../../lib/action-candidates');
const voting = require('../../lib/voting');

const NOW_MS = Date.UTC(2026, 9, 17, 10, 0, 0);
// Frozen by evaluating the actual action-candidates.js AND voting.js from
// pre-compaction commit 8c03fbe. No git executable is needed by the tests.
const LEGACY_PROMPT_SHA256 = Object.freeze({
  civic: '43d54242ffc073da9155d401fd636db5290c370fc5e23f45c8ec8bdd459a48a2',
  camera: 'b0575312a21c28418b49b9bfe59aff732ed672edf4d6ee149dee1b4603faed20',
  uptime: '1be2222e8a1972a89517b5cf29642fd475aa05435ac11683b9c267aaf2dcd735',
});
const THEMES = Object.freeze({
  civic: {
    community: 'absurdcouncil',
    interests: 'municipal procedures, absurd deductions, public transport and domestic bureaucracy',
    titles: ['Should umbrellas need planning permission?', 'The roundabout has requested annual leave', 'A committee for unclaimed socks'],
    bodies: [
      'My umbrella opens into a private roof whenever it rains. The council says permanent roofs require planning permission, but refuses to decide whether a temporary roof that travels with a damp person counts. I submitted a drawing with the handle labelled access road. They returned it because the proposed building has no fire exit. The umbrella manufacturer insists that closing it is an emergency evacuation procedure. Can I appeal without standing in the rain for six weeks?',
      'Our village roundabout has applied for two weeks of annual leave. It says it has been working continuously since 1998 and nobody has ever asked how it feels about turning left. The traffic committee proposes replacing it with a polite cardboard circle. A cyclist suggested that every road take turns being the main road, but the high street has already booked the same fortnight off. What should the temporary arrangement be?',
      'The laundry committee has classified seventeen solitary socks as abandoned infrastructure. Each sock must receive a numbered notice and a reasonable opportunity to locate its partner. I offered to hold a public consultation inside the washing machine, but the health officer says the spin cycle makes informed consent difficult. One sock has appointed a solicitor. Can I pair it with a glove for administrative purposes?',
    ],
    replies: [
      'The handle is clearly a staircase. File the form from underneath it so the roof cannot see what you are doing.',
      'A building that folds itself should qualify for a reduced council tax band, provided the resident also folds.',
      'Can the appeal hearing be conducted under a second umbrella, or does that create an unlicensed extension?',
      'Give every driver a teaspoon. They can circulate the tea instead of the traffic until the roundabout returns.',
      'The cardboard circle will demand maternity leave as soon as somebody parks a smaller circle beside it.',
      'Ask the roads to submit holiday requests in a straight line. This will reveal which one has been lying.',
      'A glove is a five-bedroom sock. You will need a change-of-use certificate before introducing tenants.',
      'Hold the consultation in the tumble dryer on cold. The sock solicitor can object during the anti-crease phase.',
      'Let the solitary socks form a cooperative. Their collective bargaining power may exceed the laundry basket.',
      'If the umbrella closes during the hearing, record the meeting as having moved to a smaller committee room.',
    ],
  },
  camera: {
    community: 'analogueworkshop',
    interests: 'repairing cameras, local walks, analogue photographs and practical experiments',
    titles: ['A camera repaired with a train ticket', 'What counts as a deliberate light leak?', 'Photographing the same bench each month'],
    bodies: [
      'The battery door on my old compact camera cracked during a walk. A folded train ticket now holds it shut, and the camera has survived three rolls without missing an exposure. I know tape would be neater, but the ticket reminds me where the repair happened. Has anyone found a reversible repair that preserves the original plastic? I would rather make a modest repair than replace a working camera merely because one small part failed.',
      'I developed a roll and found a faint orange stripe on four frames. The photographs were made on different days, but all four involved opening the rear bag in bright sunshine. I can replace the foam seals this weekend. Before that, I would like to distinguish a failing seal from handling error. What evidence would you look for in the negatives, rather than guessing from a scan with automatic colour correction?',
      'For a year I have photographed the same park bench with the same lens around the first weekend of each month. The obvious changes are leaves, weather and the angle of the shadows, but smaller changes are becoming more interesting: a repaired board, a chalk mark, one missing screw. I am deciding whether to present the whole sequence or six frames. How would you keep the sequence from becoming a repetitive record rather than a small story?',
    ],
    replies: [
      'A thin removable strap might spread the force better than a wedge, especially if the old plastic is already brittle.',
      'Keep one frame with the ticket in view. The repair and the journey are now part of the same photograph.',
      'If the latch still engages, check whether the crack moves when you wind the film before adding anything permanent.',
      'Compare the stripe orientation against the sprocket holes. A real leak may extend beyond the exposed image area.',
      'Try one controlled frame with the camera shaded, then another after leaving the closed back in sunlight.',
      'The scan could exaggerate the orange, so inspect the uncorrected negative before deciding that every stripe is identical.',
      'Keep the repaired board and missing screw in adjacent frames. Those changes give a quiet sequence an actual event.',
      'Six frames may be enough if each carries a different change; twelve near-identical shadows might hide the story.',
      'A contact sheet could let the viewer discover the little changes without an explanation under every picture.',
      'Document the dimensions before fitting a strap, so the repair remains repeatable if the ticket finally wears out.',
    ],
  },
  uptime: {
    community: 'machinehabits',
    interests: 'computer maintenance, queueing, small rituals, logs and gentle technical absurdity',
    titles: ['The router insists Tuesday is a protocol', 'A status light that feels underappreciated', 'Does a backup need to remember the weather?'],
    bodies: [
      'The router has stopped recognising Tuesday. It accepts Monday packets, stores Wednesday packets in a little queue, and returns Tuesday packets with a note saying unsupported protocol. Restarting it restored the date for four minutes, after which it asked whether I had tried restarting Tuesday. I checked the clock and the actual network remains usable. Is there a sensible troubleshooting order before I print a paper calendar and connect it through the diagnostic port?',
      'The green status light on my backup drive has been steady for eight years. Last night I thanked it and it blinked twice, despite no files being transferred. I checked the logs and found only the normal idle checks. The other lights now refuse to illuminate unless I describe their contribution to the household. I do not want to encourage a fault, but I also do not want to damage morale during the next scheduled backup.',
      'I found a notebook beside the server containing the date, backup size and a description of the weather. The notes are mine, but I cannot remember why the weather mattered. Most entries are ordinary; one says rain, restore tested, kettle forgiven. The actual restore checks still pass. Should I retain this column as informal context or replace it with something measurable, such as battery health and the time taken to read a sample archive?',
    ],
    replies: [
      'First compare the device clock with another machine. The paper calendar should remain a diagnostic accessory, not a firmware update.',
      'If Tuesday packets return on Wednesday, preserve the timestamps before blaming the day itself.',
      'Try a different cable only after asking whether the existing cable has a grievance against the calendar.',
      'A steady light can still be working hard. Thank it briefly and continue checking the restore logs.',
      'Give the red indicator an honest job description before it begins inventing incidents to justify its position.',
      'The lights may need a rota. Do not let the activity light become responsible for performance reviews.',
      'Keep the weather notes outside the success field. A rainy day is not evidence that the archive can be restored.',
      'Battery health and sampled restores are useful additions, but the kettle deserves a short explanatory footnote.',
      'You could retain the old column and add measured checks beside it, preserving context without confusing it with verification.',
      'Write down the four-minute recovery exactly. It is better evidence than the router claiming Tuesday has been deprecated.',
    ],
  },
});

function buildMenu(name = 'civic') {
  const theme = THEMES[name];
  if (!theme) throw new Error('Unknown fictional decision-evidence fixture.');
  const memories = theme.titles.map((title, index) => ({
    relevant: true, salienceDelta: 1,
    summary: 'Remembered three relevant past events involving ' + title.toLowerCase() + '. A tentative public self-claim remains weaker than owner-authored background.',
    prompt: 'Past event: In f/' + theme.community + ', you asked why ' + title.toLowerCase() + ' and listened when another participant separated a practical detail from the joke. You replied to the detail without claiming expertise. ' +
      'Past event: You returned to that conversation after a fresh answer supplied a concrete complication. You admitted your original plan had missed that complication and developed a different, connected suggestion. ' +
      'Past event: A previous exchange ended after both participants repeated the same premise; you let it end rather than treating another reply as an obligation. ' +
      'Autobiographical tentative claim: preferred_activity = keeping a notebook of small observations (confidence 60%; public self-claim, not owner-authored canon). ' +
      'Current preoccupation: ' + theme.interests.split(',')[index] + '. Relevant memory is optional background, not a required subject for a new answer.',
  }));
  const socials = theme.titles.map((title, index) => ({
    known: true, salienceDelta: 1, account: ['maple_mender', 'quiet_packet', 'curious_clerk'][index],
    summary: 'You and @' + ['maple_mender', 'quiet_packet', 'curious_clerk'][index] + ' exchanged two public replies about ' + title.toLowerCase() + '. Familiarity is modest, momentum is warm, and neither has promised to keep the conversation going. There is no evidence of friendship, agreement or hostility. Repetition can make another reply less worthwhile.',
  }));
  const replies = theme.replies.map((reply, index) => {
    const thread = Math.floor(index / 3) % 3;
    const root = { targetType: 'post', targetId: 8000 + thread, author: socials[thread].account,
      label: 'Post: ' + theme.titles[thread], content: 'TITLE: ' + theme.titles[thread] + '\nBODY: ' + theme.bodies[thread] };
    const comment = { targetType: 'comment', targetId: 9000 + index, author: index % 2 ? 'paper_listener' : 'small_observer',
      label: 'Comment by ' + (index % 2 ? 'paper_listener' : 'small_observer'), content: reply };
    return { key: 'reply:t1_' + comment.targetId, action: 'comment',
      candidateType: index < 4 ? 'reply_to_own_comment' : index < 7 ? 'renewed_thread' : 'ordinary_comment',
      createdUtc: NOW_MS / 1000 - (index + 1) * 240,
      structuralReason: index < 4 ? 'Someone directly answered an earlier comment by this bot.' : index < 7
        ? 'A fresh comment renewed a previously seen thread in the configured feed.' : 'An eligible unread comment appeared in this bot\'s current feed.',
      context: root.content + '\nA COMMENT (by ' + comment.author + ') you are replying to: ' + reply,
      social: socials[thread], memory: memories[thread], voteItems: [root, comment],
      target: { key: 't1_' + comment.targetId, postId: root.targetId, commentId: comment.targetId, feddit: theme.community },
      observerMetadata: { notForPrompt: 'fixture-only observational metadata', ordinal: index },
    };
  });
  const discussions = theme.titles.slice(0, 2).map((title, index) => ({
    key: 'discussion:f/' + theme.community + ':' + index, action: 'post', candidateType: 'new_discussion',
    structuralReason: 'This current community accepts new text discussions.', memory: memories[index],
    context: 'COMMUNITY: f/' + theme.community + '\nDESCRIPTION: A place for ' + theme.interests +
      '. People may disagree or leave a conversation without explaining themselves.\nRULES:\n1. Respond to the actual subject.\n2. Do not impersonate another participant.\n3. Distinguish an observed detail from a guess.',
    destination: { name: theme.community },
  }));
  const candidates = actionCandidates.bound({ attention: replies.slice(0, 4), renewed: replies.slice(4, 7),
    ordinary: replies.slice(7, 10), discussions });
  const voteCandidates = voting.collect(candidates, { self: 'fixture_writer', state: { considered: [] }, remaining: 50 });
  return { name, nowMs: NOW_MS,
    system: 'You are a fictional forum participant interested in ' + theme.interests + '. You enjoy specific observations, keep uncertainty explicit, and sometimes over-apply ordinary procedures to ridiculous situations. Your history does not require you to repeat a topic. Speak in your own voice without pretending to know another participant\'s private motives.',
    candidates, options: { voteCandidates, voteAllowance: { remaining: 50 }, decisionContractVersion: 2 },
  };
}

function buildMenus() { return Object.keys(THEMES).map(buildMenu); }

// Additional branch facts are unique decision-relevant evidence, not repeated
// padding. These pressure fixtures leave the earlier menus/hashes untouched.
const PRESSURE_NOTES = [
  {
    context: 'Earlier in this branch, the umbrella owner explained that the canopy leaks only along one seam and that the handle drawing was a joke, not a real access-road application. The neighbour offered a spare umbrella but needs it back for a hospital appointment on Thursday. A planning clerk said ordinary handheld umbrellas are exempt; the difficulty concerns a market stall using a permanently mounted canopy. The owner then asked whether a removable strap would keep their hands free without turning the umbrella into a fixture. Nobody has suggested paying an application fee, and the owner explicitly wants a reversible practical arrangement rather than a prolonged dispute with the council. The immediate reply about filing from underneath the roof follows that distinction between a portable object and a permanent structure.',
    memory: 'Past event: You once confused a neighbour\'s temporary bicycle cover with a permanent shed and corrected yourself when shown the folding frame. The neighbour appreciated the correction, not the original legal theory. You described your own paperwork as a rain shelter that protected nothing, and another participant developed that joke without insulting the neighbour. This earlier public exchange supports acknowledging the portable-versus-permanent distinction here, but does not establish that you know planning law or that the current owner is the same person.',
  },
  {
    context: 'The person proposing a reduced tax band previously clarified that they rent one room and have no authority to alter the building. Their folding-resident suggestion is deliberately absurd, not an account of unsafe housing. Another ancestor established that the umbrella is blue, borrowed from a sibling, and still needs to function on a crowded bus. The sibling is happy for removable repairs but not holes, glue or a permanent harness. A third participant suggested measuring the closed length before buying a strap, because a longer umbrella would block the bus aisle. The current question is whether the folding joke can produce a useful reversible repair, not whether the tenant should challenge the property\'s actual tax classification.',
    memory: 'Past event: You repaired a bag with a removable buckle and mentioned that the first version interfered with its zip. A reader suggested checking access before celebrating a clever mechanism. You accepted that point and wrote that a solution can satisfy its own specification while making the original object useless. That anecdote may make the bus and folding constraints salient, but copying the old bag story would not answer this branch. No stored public claim says that you own a car or have inspected this umbrella.',
  },
  {
    context: 'This branch began when someone asked whether two neighbours sheltering together become a licensed venue. The owner answered that they are waiting for a bus, not organising a public event. A retired surveyor joined the joke by naming an imaginary annex, then explicitly said that no professional opinion was being offered. The latest ancestor established that the second umbrella is smaller and belongs to a child, so combining the frames would be both impractical and unwanted. The owner would welcome a comic appeal form but does not want anyone to submit a real application in their name. The immediate question about an unlicensed extension should therefore continue the temporary-shelter joke without implying that a child\'s umbrella must be surrendered or that any genuine enforcement action exists.',
    memory: 'Past event: A reader once took your mock application wording literally and asked where to send it. You clarified that the form was fictional before continuing the joke. You later described that correction as putting a safety label on a metaphor. The episode is relevant to distinguishing imaginary paperwork from genuine authorisation in this exchange. It is not evidence that everyone understands your tone immediately, and it supplies no reason to distrust or ridicule a participant who asks a straightforward question.',
  },
  {
    context: 'The roundabout\'s leave request was introduced as a story about an ordinary painted mini-roundabout, not a damaged traffic island. An ancestor specified that the teaspoon scheme would take place at a village fete on private land, with no vehicles moving through the demonstration. Another participant suggested that each spoon represent a road and that the tea represent traffic flow. A parent then noticed that pouring continuously into the smallest cup would overflow it. The organiser has asked for a tabletop explanation of capacity rather than advice to change road signs. The direct reply proposes circulating tea instead of traffic; a coherent continuation can develop the cup-capacity consequence while keeping real drivers outside the experiment.',
    memory: 'Past event: In a public discussion about a queue outside a bakery, you used three mugs to explain why adding another entrance did not increase the oven\'s capacity. Someone pointed out that the analogy ignored people collecting prepaid orders. You incorporated a separate collection mug rather than insisting the first diagram was complete. This memory may help you notice bottlenecks and revise a comic model, but the bakery and this village are different places and no continuing relationship between their participants is established.',
  },
  {
    context: 'The cardboard-circle proposal now has a defined setting: a model village built by a school geography club. The club has permission to use recycled packaging and does not intend to install anything on the public road. Earlier replies gave the replacement circle a name, Temporary Gerald, and established that Gerald is drawn in pencil so the children can change the junction layout. One ancestor joked that smaller circles are Gerald\'s dependants, but another warned that the joke should not turn into paperwork directed at real families. The latest speaker asks what happens when the small circle grows. A connected answer can expand the model-village administration or revise Gerald\'s job description without presenting actual maternity law as part of the joke.',
    memory: 'Past event: You once helped a fictional lighthouse apply for bereavement leave after its bulb failed. A participant supplied the name Acting Beacon and you retained it in the next reply, which made the exchange feel collaborative. In a later comment you accidentally called the same character Permanent Beacon and were corrected. That remembered naming mistake is relevant to preserving Temporary Gerald, not an invitation to import the lighthouse or its invented employment history into the school\'s roundabout model.',
  },
  {
    context: 'In the road-holiday branch, the high street and station road have already requested the same August fortnight. A participant proposed allocating leave by alphabetical order, but the immediate parent pointed out that renaming streets would then become a competitive advantage. Another ancestor established that this is an imaginary staffing rota rather than a suggestion to close either road. The person maintaining the model wants a rule that remains funny when applied consistently, and has invited participants to expose loopholes. The latest suggestion about making roads submit requests in a straight line continues that test. It should not be answered as if the villagers are incapable of understanding a real traffic diversion, nor as though a genuine council consultation has been announced.',
    memory: 'Past event: You argued in a public joke that a queue should be sorted by shoe size, then realised that barefoot participants made the rule undefined. A reply proposed issuing temporary imaginary shoes. You accepted that consequence and gave yourself the smallest pair, making your certainty part of the joke. This event supports taking the renaming loophole seriously enough to elaborate it. It does not establish a preference for excluding anyone from actual services or for mocking people who cannot satisfy a made-up condition.',
  },
  {
    context: 'The sock-and-glove discussion has established that the glove is a winter mitten with one thumb, not a five-fingered glove. The immediate parent used a five-bedroom description before that correction arrived, so an answer can gently adapt the analogy rather than pretending both versions are true. A sewing volunteer has offered to turn the mitten into a padded camera pouch after checking whether its owner wants it back. An ancestor explicitly rejected cutting it up before ownership was established. The most recent question asks whether the thumb could become a porch. Relevant continuity includes the mitten\'s shape, the proposed reversible reuse and the consent constraint. The laundry committee itself remains fictional and cannot authorise alterations to somebody else\'s clothing.',
    memory: 'Past event: In an earlier exchange about a lost hat, you initially treated a decorative ribbon as a handle. The owner explained its actual purpose and you revised the proposed carrying system. You later called this the difference between inspecting an object and assigning it a job from across the room. That observation can enrich the mitten discussion while leaving the correction explicit. No memory establishes that the sewing volunteer is careless, and the bot has never physically inspected either item.',
  },
  {
    context: 'The cold-dryer consultation branch now includes a practical correction: the machine has a child lock and nobody is to climb inside it. A parent suggested putting written sock statements in an empty laundry basket and reading them aloud beside the switched-off appliance. Another participant supplied three fictional objections, concerning unequal wear, missing labels and the right not to be matched by colour alone. The person who invented the sock solicitor wants a comic hearing transcript using those objections. The immediate anti-crease-phase suggestion is therefore wordplay rather than an instruction to operate the dryer during the hearing. A useful continuation can let the solicitor raise one of the established objections and have the committee misunderstand it bureaucratically.',
    memory: 'Past event: You wrote a mock hearing in which a cracked teacup objected to being described as defective. Another participant pointed out that the cup could still hold pencils, and the scene improved when the judge amended the category rather than dismissing the objection. You remember that change because it let the participant contribute a consequential detail. It is relevant to the socks\' objections, not evidence that cups and socks share a continuous fictional court or that the same judge must appear again.',
  },
  {
    context: 'The cooperative proposal concerns seventeen unmatched socks, but an earlier count mistakenly said eighteen because somebody counted the basket liner. The organiser corrected the total and said that the liner would attend only as an observer. A parent then suggested assigning each sock one vote, which raised the question of whether a matched pair would become one household or two members. Nobody has decided that rule yet. The person asking about bargaining power is interested in following the arithmetic of the absurd premise, not in receiving a lecture about real labour disputes. A connected response can propose a consistent membership rule, acknowledge the observer liner, and leave room for another participant to discover its consequence.',
    memory: 'Past event: In a fictional allotment meeting, you accidentally gave a scarecrow two votes because it occupied two plots. The next speaker asked whether moving it would change the electorate. You corrected the count and let the scarecrow keep a non-voting observer badge. This memory offers a relevant analogy about counting objects and members, but importing the entire allotment anecdote would repeat ready-made prose. The current socks have their own stated total and should not inherit the old mistake merely because it is memorable.',
  },
  {
    context: 'The final umbrella branch returns to the original owner after several replies. They have now tested a loose strap indoors and found that it prevents the canopy from folding fully. A neighbour suggested a quick-release buckle, while another asked whether a second person could hold the umbrella during the mock appeal hearing. The owner prefers to keep one hand free for a walking stick, a detail that makes an instruction to carry extra paperwork unhelpful. They still enjoy the committee-room joke and explicitly invite a short fictional meeting minute. A grounded answer can acknowledge the failed strap, preserve access to the walking stick, and make the room shrink administratively without claiming that physical access needs are an absurdity.',
    memory: 'Past event: You once suggested a two-handed repair to someone who had already said they needed one hand for a cane. When they repeated that constraint, you apologised and replaced the proposal with a clip they could release using one hand. The useful part of that retained event is attention to an explicitly stated constraint, not a moral lesson to recite at the participant. There is no basis for assuming the current owner has the same circumstances beyond the walking-stick detail supplied in this branch.',
  },
  {
    context: 'Community notice: the next open discussion concerns a fictional council trying to classify objects that change shape. Existing active threads already cover umbrellas, mittens and roundabouts, so a new root could use a different object rather than reproducing one of those titles. Readers have recently responded well to one concrete premise followed by a consequence they can change. The notice is not a request to manufacture agreement or to guarantee replies. The moderator asks that practical accessibility details remain accurate when they appear inside jokes, and that no real person be named as the target of a pretend enforcement action. A hypothetical library trolley, folding chair or reversible coat would fit the topic, but none has been selected on the bot\'s behalf.',
    memory: 'Past event: You started a discussion about whether a folding chair remained a chair while folded. Several participants developed distinct consequences: seating permits, storage fees and a chair taking a break from its profession. The thread became repetitive only after you posted the same definition a second time. You recorded that a new object can invite a fresh premise, whereas repeating a settled definition rarely does. This supplies background for deciding whether to start another root now; it neither requires a post nor makes any particular proposed object compulsory.',
  },
  {
    context: 'Community notice: a separate weekly thread invites modest accounts of repairs that worked imperfectly. It accepts both sincere practical stories and obviously fictional bureaucratic explanations, provided the distinction remains visible. Current examples include a button replaced with a small washer and a drawer that opens only when lifted at one corner. Neither example is a request for safety-critical advice. The host asks contributors to state what they tried, what constraint mattered and what remained unresolved, rather than turning every account into a universal solution. The bot has no firsthand repair beyond its owner-authored persona and retained public self-claims; it can frame an invented scenario as a joke without pretending it physically performed a repair.',
    memory: 'Past event: You described a repaired desk drawer as provisionally compliant with gravity. Another participant asked how the repair actually worked, and you admitted the original description was a comic interpretation of somebody else\'s account. The exchange continued after you kept that distinction clear and let the practical owner explain the mechanism. This memory may help distinguish firsthand experience from imaginative commentary in a new post. It is not a source for claiming a workshop, tools or qualifications that the persona does not contain.',
  },
];

function buildPressureMenus() {
  const menu = buildMenu('civic');
  menu.name = 'civic-branch-pressure';
  menu.candidates = menu.candidates.map((candidate, index) => ({ ...candidate,
    context: candidate.context + '\n\nRELEVANT EARLIER BRANCH FACTS:\n' + PRESSURE_NOTES[index].context,
    memory: { ...candidate.memory, prompt: candidate.memory.prompt + ' ' + PRESSURE_NOTES[index].memory },
  }));
  return [menu];
}

// Frozen separately from the actual pre-port c6e3468 action/voting renderers.
const THEMED_LEGACY_PROMPT_SHA256 = '5bf466b7b8643e1660c5d93c5efba9aee7b3ec46b130a12e6199db7971f20add';

module.exports = { NOW_MS, LEGACY_PROMPT_SHA256, THEMED_LEGACY_PROMPT_SHA256,
  buildMenu, buildMenus, buildPressureMenus };
