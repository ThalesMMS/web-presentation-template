/** Edit the presentation identity, activities and slide sequence here. */
export const CONFIG = {
  title: 'Interactive presentation',
  subtitle: 'Live voting, messages and an interactive component for the audience',
  presenter: {
    name: 'Thales Matheus M. Santos',
    role: 'Radiologist · developer',
    contact: {
      email: 'thalesmmsradio@gmail.com',
      linkedin: 'https://www.linkedin.com/in/thales-matheus-m-santos-974314287',
      github: 'https://github.com/ThalesMMS'
    }
  },
  citation: {
    text: 'Santos, T. M. M. (2026). Interactive presentation template [Computer software]. https://github.com/ThalesMMS/web-presentation-template',
    url: 'https://github.com/ThalesMMS/web-presentation-template'
  },
  brand: {
    name: 'Your brand',
    colors: {
      background: '#0b1220',
      surface: '#111c30',
      text: '#f6f8fc',
      muted: '#b7c2d8',
      accent: '#74d4b3',
      accentStrong: '#31b98a'
    }
  },
  features: {
    canvas: { enabled: true, url: 'http://192.168.0.10:8086/', label: 'Canvas' },
    points: { enabled: false }
  },
  timing: {
    totalMinutes: 30,
    slides: { 'poll-live': 5, 'poll-secret': 3, 'exam-1': 8, 'exam-2': 6, 'cloudflare-hosting': 2, closing: 2 }
  },
  polls: {
    region: {
      question: 'Which continent are you from?',
      type: 'single',
      options: [
        { id: 'africa', label: 'Africa' },
        { id: 'antarctica', label: 'Antarctica' },
        { id: 'asia', label: 'Asia' },
        { id: 'europe', label: 'Europe' },
        { id: 'north-america', label: 'North America' },
        { id: 'oceania', label: 'Oceania' },
        { id: 'south-america', label: 'South America' }
      ]
    },
    age: {
      question: 'Select your age range',
      type: 'single',
      options: [
        { id: 'under-25', label: 'Under 25' },
        { id: '25-34', label: '25–34' },
        { id: '35-44', label: '35–44' },
        { id: '45-54', label: '45–54' },
        { id: '55-plus', label: '55 or older' }
      ]
    },
    'exam-1': {
      question: 'What is the most likely diagnosis?',
      type: 'single',
      correct: 'neoplasia',
      options: [
        { id: 'neoplasia', label: 'Neoplasia' },
        { id: 'trauma', label: 'Trauma' },
        { id: 'infection', label: 'Infection' },
        { id: 'autoimmune', label: 'Autoimmune' }
      ]
    },
    'exam-2': {
      question: 'What is the most likely diagnosis?',
      type: 'single',
      correct: 'neoplasia',
      options: [
        { id: 'neoplasia', label: 'Neoplasia' },
        { id: 'trauma', label: 'Trauma' },
        { id: 'infection', label: 'Infection' },
        { id: 'autoimmune', label: 'Autoimmune' }
      ]
    }
  },
  boards: {
    region: { title: 'Messages', moderation: 'auto' },
    'exam-1': { title: 'Discussion', moderation: 'auto' },
    'exam-2': { title: 'Discussion', moderation: 'manual' }
  },
  exams: {
    'abdomen-ct': {
      title: 'Abdominal CT',
      studyId: 'visible-human-abdomen-ct',
      src: '/dicom-slide/exams/library/visible-human-abdomen-ct/study.js'
    },
    'brain-mr': {
      title: 'Brain MR',
      studyId: 'mri-dir-t1-mr',
      src: '/dicom-slide/exams/library/mri-dir-t1-mr/study.js'
    }
  },
  slides: [
    {
      id: 'cover', type: 'cover', eyebrow: 'Live demo', title: 'Interactive presentation',
      topics: ['Control room (régie)', 'Live voting', 'Messages and questions from the audience', 'Interactive component for the audience']
    },
    {
      id: 'poll-live', type: 'content', eyebrow: 'Live voting + public messages', title: 'Where are you from?',
      poll: 'region', pollResults: 'live', board: 'region'
    },
    {
      id: 'poll-secret', type: 'content', eyebrow: 'Secret voting + private messages', title: 'Tell us about you',
      poll: 'age', pollResults: 'hidden',
      explanation: 'Votes stay hidden until the next slide. On this slide you can also send a message to the presenter, with or without your name. Those messages are shown only in the control room.'
    },
    {
      id: 'poll-results', type: 'content', eyebrow: 'Results', title: 'Age range',
      poll: 'age', pollResults: 'final'
    },
    {
      id: 'exam-1', type: 'content', eyebrow: 'Interactive exam', title: 'Case 1',
      exam: 'abdomen-ct', poll: 'exam-1', pollResults: 'live', board: 'exam-1'
    },
    {
      id: 'exam-1-continued', type: 'content', eyebrow: 'Interactive exam', title: 'Case 1 — discussion',
      items: [
        'Slides can advance while the exam stays open on every phone',
        'Votes keep counting until the poll is closed',
        'Use the control room to moderate the discussion'
      ],
      audienceExam: 'abdomen-ct', audiencePoll: 'exam-1', questions: false
    },
    {
      id: 'pause', type: 'pause', eyebrow: 'Break', title: 'Back in 5 minutes',
      description: 'Use your phone to send questions to the speaker.', audienceExam: null
    },
    {
      id: 'exam-2', type: 'content', eyebrow: 'Interactive exam', title: 'Case 2',
      exam: 'brain-mr', poll: 'exam-2', pollResults: 'hidden', audienceBoard: 'exam-2'
    },
    {
      id: 'exam-2-results', type: 'content', eyebrow: 'Results', title: 'Case 2 — answers',
      poll: 'exam-2', pollResults: 'final', board: 'exam-2', audienceExam: 'brain-mr'
    },
    {
      id: 'cloudflare-hosting', type: 'content', eyebrow: 'Hosting with Cloudflare', title: 'Put your presentation online',
      items: [
        'Create a Cloudflare account. Cloudflare keeps your presentation online and connects the audience’s phones.',
        'Download this template from GitHub and install Node.js, the tool used to prepare it for publishing.',
        'Follow the README’s Deploy steps to connect your account and create a private password for the presenter.',
        'Publish with npm run deploy. Cloudflare uploads the slides and live activities, then gives you a web address.',
        'Share that address ending in /participar/, or show the QR code. Keep your presenter password private.'
      ]
    },
    {
      id: 'closing', type: 'closing', eyebrow: 'Thank you', title: 'Thank you!',
      description: 'Questions? Reach out.'
    }
  ]
};
