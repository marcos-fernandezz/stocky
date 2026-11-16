import Link from "next/link";

export default function Home() {
  return (
    <>
      <header>
        <h1>Stocky · reposición de góndolas</h1>
      </header>
      <main id="contenido">
        <div className="card">
          <div className="row">
            <span>
              <span className="name">Repositor</span>
              <br />
              <span className="muted">Avisos de pasada, góndolas a revisar y quiebres. Abrir en el celular.</span>
            </span>
            <Link href="/repositor" className="big">Abrir</Link>
          </div>
        </div>
        <div className="card">
          <div className="row">
            <span>
              <span className="name">Encargado</span>
              <br />
              <span className="muted">Pasadas por día, estado de la sucursal, avisos de sin stock y simulador de caja.</span>
            </span>
            <Link href="/encargado" className="big">Abrir</Link>
          </div>
        </div>
      </main>
    </>
  );
}
