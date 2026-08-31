/**
 * Este é o arquivo principal do template.
 * Edite a identidade visual, as enquetes e a sequência de slides.
 */
export const CONFIG = {
  title: 'Título da apresentação',
  subtitle: 'Uma frase curta sobre o encontro',
  presenter: {
    name: 'Nome do apresentador',
    role: 'Cargo ou organização'
  },
  brand: {
    name: 'Sua marca',
    colors: {
      background: '#0b1220',
      surface: '#111c30',
      text: '#f6f8fc',
      muted: '#b7c2d8',
      accent: '#74d4b3',
      accentStrong: '#31b98a'
    }
  },
  polls: {
    warmup: {
      question: 'Como você chega para esta conversa?',
      type: 'single',
      options: [
        { id: 'curious', label: 'Com curiosidade' },
        { id: 'practical', label: 'Buscando ideias práticas' },
        { id: 'experienced', label: 'Já tenho experiência no tema' },
        { id: 'unsure', label: 'Ainda não sei o que esperar' }
      ]
    },
    priorities: {
      question: 'Quais pontos merecem mais atenção?',
      type: 'multiple',
      exclusive: 'none',
      options: [
        { id: 'people', label: 'Pessoas' },
        { id: 'process', label: 'Processos' },
        { id: 'technology', label: 'Tecnologia' },
        { id: 'measurement', label: 'Medição de resultados' },
        { id: 'none', label: 'Nenhum destes' }
      ]
    }
  },
  slides: [
    {
      type: 'cover',
      eyebrow: 'Apresentação interativa',
      title: 'Título da apresentação',
      highlight: 'com participação ao vivo',
      description: 'Aponte a câmera para o QR code e acompanhe pelo celular.'
    },
    {
      type: 'statement',
      eyebrow: 'Abertura',
      title: 'Uma ideia clara por slide.',
      description: 'Use pouco texto e deixe espaço para a conversa acontecer.'
    },
    {
      type: 'poll',
      poll: 'warmup',
      eyebrow: 'Enquete ao vivo'
    },
    {
      type: 'list',
      eyebrow: 'Estrutura',
      title: 'Três pontos para desenvolver',
      items: [
        'Contexto: por que este assunto importa agora',
        'Prática: o que muda no trabalho',
        'Próximo passo: o que fazer depois da apresentação'
      ]
    },
    {
      type: 'poll',
      poll: 'priorities',
      eyebrow: 'Escolha múltipla'
    },
    {
      type: 'quote',
      eyebrow: 'Síntese',
      quote: 'A frase que você quer que a plateia leve para casa.',
      attribution: 'Mensagem principal'
    },
    {
      type: 'closing',
      eyebrow: 'Obrigado',
      title: 'Vamos continuar a conversa?',
      description: 'Contato, chamada para ação ou próximo encontro.'
    }
  ]
};
