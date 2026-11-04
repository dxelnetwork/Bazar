import './style.css';

export const metadata = {
  title: 'Bazar Manager',
  description: 'Shared bazar tracker with monthly accounting',
};

export default function Layout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
