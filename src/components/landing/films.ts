export type Film = {
  id: string;
  num: string;
  title: string;
  duration: string;
  accent: string;
  src: string;
  poster: string;
};

const FILMS: Film[] = [
  {
    id: '01-update',
    num: '01',
    title: 'Update',
    duration: '0:23',
    accent: '#ADFF02',
    src: '/films/01-update.mp4',
    poster: '/films/01-update.jpg',
  },
  {
    id: '02-restyle',
    num: '02',
    title: 'Restyle',
    duration: '0:16',
    accent: '#F472B6',
    src: '/films/02-restyle.mp4',
    poster: '/films/02-restyle.jpg',
  },
  {
    id: '03-add',
    num: '03',
    title: 'Add',
    duration: '0:21',
    accent: '#38BDF8',
    src: '/films/03-add.mp4',
    poster: '/films/03-add.jpg',
  },
  {
    id: '04-ship',
    num: '04',
    title: 'Fix & Ship',
    duration: '0:19',
    accent: '#34D399',
    src: '/films/04-ship.mp4',
    poster: '/films/04-ship.jpg',
  },
];

export function getFilm(id: string): Film | undefined {
  return FILMS.find(film => film.id === id);
}
