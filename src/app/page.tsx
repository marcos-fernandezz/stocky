import Link from "next/link";

export default function Home() {
  return (
    <>
      <header>
        <h1>Stocky · stock en góndola</h1>
      </header>
      <main>
        <div className="card">
          <div className="row">
            <span>
              <span className="name">Repositor</span>
              <br />
              <span className="muted">Lista de reposición en vivo, conteos y avisos urgentes. Abrir en el celular.</span>
            </span>
            <Link href="/repositor" className="big">Abrir</Link>
          </div>
        </div>
        <div className="card">
          <div className="row">
            <span>
              <span className="name">Encargado</span>
              <br />
              <span className="muted">Estado de la sucursal, alertas sin depósito y simulador de caja.</span>
            </span>
            <Link href="/encargado" className="big">Abrir</Link>
          </div>
        </div>
      </main>
    </>
  );
}
