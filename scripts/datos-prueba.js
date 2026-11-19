"use strict";
// Datos de prueba INVENTADOS para el ambiente de staging y las pruebas
// automáticas del conector MCP. Ninguna persona, RUT, correo ni empresa
// corresponde a datos reales (los correos usan el dominio reservado
// .example, que no existe; los RUT son 0.000.00N-0, que no pueden
// pertenecer a nadie).
//
// Resguardos para que esto JAMÁS escriba en producción:
//   1. Solo se llama si SEMBRAR_DATOS_PRUEBA=true (no existe en producción).
//   2. Se niega si el servicio de Render se llama como el de producción.
//   3. Se niega si la base ya tiene cualquier registro que no sea de prueba.
//   4. Exige CLAVE_DATOS_PRUEBA (Render la genera al azar en staging).

const NOMBRE_SERVICIO_PRODUCCION = "prevencion-riesgos-api-pehuen";
const PREFIJO = "prueba-";

function isoMas(hoy, dias) {
  const d = new Date(hoy + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}
function hoyChile() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

// Construye las dos empresas de prueba. Fechas relativas a "hoy" para que
// siempre haya vencidos, atrasados y por vencer.
function construirEmpresas(hoy, hashClave) {
  const d = (n) => isoMas(hoy, n);
  const empresa = (id, nombre, rubro, numTrabajadores, sufijo) => {
    const p = (x) => `${x}-${sufijo}`;
    const perfiles = [
      { id: p("perfil-admin"), nombre: "Administrador", esAdmin: true, vistas: ["dashboard", "matriz", "programa", "capacitacion", "documentos", "config"] },
      { id: p("perfil-prev"), nombre: "Prevencionista de Riesgos", esAdmin: false, vistas: ["dashboard", "matriz", "programa", "capacitacion", "documentos", "cumplimiento", "accidentabilidad", "riohys"] },
      { id: p("perfil-sup"), nombre: "Jefe de Obra / Supervisor", esAdmin: false, vistas: ["dashboard", "realizar-inspecciones", "inspecciones", "matriz", "programa", "capacitacion", "accidentabilidad", "emergencia", "compromisos"] },
      { id: p("perfil-trab"), nombre: "Trabajador", esAdmin: false, descargaDashboard: false, vistas: ["dashboard", "realizar-inspecciones"] },
      { id: p("perfil-cap"), nombre: "Encargada de capacitación", esAdmin: false, puedeAceptarRiesgos: false, vistas: ["capacitacion"] },
    ];
    const u = (rol, nombre, perfil, extra) => Object.assign({ id: p("usr-" + rol), nombre, cargo: perfil.nombre, perfilId: perfil.id, email: `${rol}@${sufijo}.pehuen-prueba.example`, claveHash: hashClave, activo: true }, extra || {});
    const usuarios = [
      u("admin", "Ada Prueba Admin", perfiles[0]), u("prevencionista", "Pía Prevención Ficticia", perfiles[1]),
      u("supervisor", "Sergio Supervisor Inventado", perfiles[2]), u("trabajador", "Tomás Trabajador Ejemplo", perfiles[3]),
      u("capacitacion", "Carla Capacitación Demo", perfiles[4]), u("inactivo", "Iván Inactivo Prueba", perfiles[1], { activo: false }),
      // Mismo correo en las dos empresas: prueba la selección de empresa.
      Object.assign(u("multi", "Mario Multiempresa Ficticio", perfiles[1]), { email: "multi@pehuen-prueba.example" }),
    ];
    const areas = [{ id: p("area-taller"), nombre: "Taller" }, { id: p("area-terreno"), nombre: "Terreno" }, { id: p("area-oficina"), nombre: "Oficina" }];
    const [taller, terreno, oficina] = areas.map((a) => a.id);
    const trabajadores = [
      { id: p("trab-1"), nombre: "Ana Ejemplo Uno", rut: "0.000.001-0", cargo: "Maestro", areaId: taller, roles: ["comite_paritario"] },
      { id: p("trab-2"), nombre: "Bruno Ejemplo Dos", rut: "0.000.002-0", cargo: "Maestro", areaId: taller, roles: [] },
      { id: p("trab-3"), nombre: "Camila Ejemplo Tres", rut: "0.000.003-0", cargo: "Liniero", areaId: terreno, roles: ["delegado"] },
      { id: p("trab-4"), nombre: "Diego Ejemplo Cuatro", rut: "0.000.004-0", cargo: "Liniero", areaId: terreno, roles: [] },
      { id: p("trab-5"), nombre: "Elena Ejemplo Cinco", rut: "0.000.005-0", cargo: "Administrativa", areaId: oficina, roles: ["prevencionista"] },
      { id: p("trab-6"), nombre: "Felipe Ejemplo Seis", rut: "0.000.006-0", cargo: "Conductor", areaId: terreno, roles: [] },
    ];
    const programaPersonas = [
      { id: p("per-1"), nombre: "Pía Prevención Ficticia", cargo: "Prevencionista de Riesgos" },
      { id: p("per-2"), nombre: "Sergio Supervisor Inventado", cargo: "Supervisor" },
      { id: p("per-3"), nombre: "Elena Ejemplo Cinco", cargo: "Administrativa", trabajadorId: p("trab-5") },
    ];
    const ctl = (j, texto, responsable, plazo) => ({ jerarquia: j, texto, responsable: responsable || "", plazo: plazo || "", documentoId: null });
    const linea = (n, areaId, actividad, peligro, riesgo, pr, co, extra) => {
      const controles = (extra && extra.controlesJerarquizados) || [];
      return Object.assign({
        id: p("miper-" + n), areaId, proceso: "Mantención", actividad, categoria: "Mecánico", peligro, riesgo, efecto: "Lesión", hombres: 3, mujeres: 1, otros: 0,
        probabilidad: pr, consecuencia: co, sensible: false, gruposSensibles: [], simboloOficial: "seg-caida-mismo-nivel", simboloDetalle: "",
        controlesJerarquizados: controles, controles: controles.map((c) => `• ${c.jerarquia}) ${c.texto}`).join("\n"),
        responsable: controles.filter((c) => c.responsable).map((c) => `• ${c.jerarquia}) ${c.responsable}`).join("\n"), plazo: "",
        estado: "pendiente", revisado: false, fechaRevision: "", fechaCreacion: new Date(hoy + "T12:00:00Z").toISOString(),
      }, extra || {});
    };
    const matriz = [
      linea(1, taller, "Uso de esmeril angular", "Proyección de partículas", "Lesión ocular", 4, 4, { controlesJerarquizados: [ctl("C", "Instalar protección fija en el esmeril", "Sergio Supervisor Inventado", d(20)), ctl("E", "Uso obligatorio de careta facial", "")] }),
      linea(2, terreno, "Trabajos desde canastillo", "Trabajo en altura", "Caída de altura", 3, 5, { simboloOficial: "seg-caida-altura", controlesJerarquizados: [ctl("D", "Procedimiento de trabajo en altura", "Pía Prevención Ficticia")] }),
      linea(3, terreno, "Tendido de línea o reemplazo de conductor", "Contacto eléctrico", "Electrocución", 2, 5, { probabilidadResidual: 1, consecuenciaResidual: 5 }),
      linea(4, oficina, "Trabajo con computador", "Postura prolongada", "Trastorno musculoesquelético", 3, 2, { categoria: "Ergonómico", controlesJerarquizados: [ctl("D", "Pausas activas", "")], probabilidadResidual: 2, consecuenciaResidual: 2,
        aceptacionRiesgo: { fecha: d(-200), por: "Pía Prevención Ficticia", justificacion: "Controles aplicados (dato de prueba).", revisarEn: d(20), nivel: "medio", controlesAplicados: 1, revocada: false } }),
      linea(5, taller, "Manipulación de herramientas", "Golpes", "Contusión", 2, 2, {}),
      linea(6, taller, "Almacenamiento", "Caída de objetos", "Golpe por objeto", 3, 3, { controlesJerarquizados: [ctl("D", "Orden y aseo semanal", "")] }),
    ];
    const plan = [
      { id: p("pa-1"), matrizId: p("miper-1"), controlesValidados: true, observacionValidacion: "", tipoAccion: "mitigar", actividad: "Instalar guarda en esmeril", plazo: d(-5), responsable: "Sergio Supervisor Inventado", presupuesto: 150000, recursos: "", proximaRevision: "", estado: "proceso", ronda: 1, probAntes: 4, consAntes: 4, probDespues: null, consDespues: null, eficaciaObservacion: "", fechaCreacion: new Date().toISOString() },
      { id: p("pa-2"), matrizId: p("miper-2"), controlesValidados: false, observacionValidacion: "", tipoAccion: "mitigar", actividad: "Comprar líneas de vida", plazo: d(15), responsable: "Pía Prevención Ficticia", presupuesto: null, recursos: "", proximaRevision: "", estado: "pendiente", ronda: 1, probAntes: 3, consAntes: 5, probDespues: null, consDespues: null, eficaciaObservacion: "", fechaCreacion: new Date().toISOString() },
    ];
    const programa = [
      { id: p("pg-1"), nombre: "Inspección de herramientas", tipo: "inspeccion", areaId: taller, responsable: "Sergio Supervisor Inventado", fechaProgramada: d(-30), fechaRealizada: d(-29) },
      { id: p("pg-2"), nombre: "Simulacro de evacuación", tipo: "simulacro", areaId: oficina, responsable: "Pía Prevención Ficticia", fechaProgramada: d(-10), fechaRealizada: null },
      { id: p("pg-3"), nombre: "Charla de 5 minutos", tipo: "difusion", areaId: terreno, responsable: "Sergio Supervisor Inventado", fechaProgramada: d(-3), fechaRealizada: d(-3) },
      { id: p("pg-4"), nombre: "Reunión comité paritario", tipo: "comite", areaId: oficina, responsable: "Elena Ejemplo Cinco", fechaProgramada: d(12), fechaRealizada: null },
      { id: p("pg-5"), nombre: "Inspección de vehículos", tipo: "inspeccion", areaId: terreno, responsable: "Pía Prevención Ficticia", fechaProgramada: d(-1), fechaRealizada: null },
    ];
    const capacitaciones = [
      { id: p("cap-1"), nombre: "Inducción hombre nuevo", tipo: "Inducción", fechaProgramada: d(-20), fechaRealizada: d(-20), horas: 4, relator: "Pía Prevención Ficticia", documentoId: "", dirigidaA: { tipo: "todos", cargos: [], personasIds: [] },
        participantes: trabajadores.map((t, i) => ({ trabajadorId: t.id, asistio: i < 4, aprobado: i < 3 })) },
      { id: p("cap-2"), nombre: "Trabajo en altura", tipo: "Específica por riesgo del puesto", fechaProgramada: d(-2), fechaRealizada: null, horas: 8, relator: "Relator Externo Ficticio", documentoId: "", dirigidaA: { tipo: "cargos", cargos: ["Liniero"], personasIds: [] },
        participantes: [{ trabajadorId: p("trab-3"), asistio: false, aprobado: false }, { trabajadorId: p("trab-4"), asistio: false, aprobado: false }] },
      { id: p("cap-3"), nombre: "Uso de extintores", tipo: "Refuerzo / recapacitación", fechaProgramada: d(25), fechaRealizada: null, horas: 2, relator: "Sergio Supervisor Inventado", documentoId: "", dirigidaA: { tipo: "ninguno", cargos: [], personasIds: [] }, participantes: [] },
    ];
    const cursosObligatorios = [
      { id: p("curso-general"), nombre: "Capacitación general del trabajador", tema: "Prevención de riesgos general", horas: "8", metodologia: "presencial", tipoCertificacion: "Certificado de participación", vigenciaAnios: 2, tramoMinimo: "todas", aplicaA: ["todos"] },
      { id: p("curso-comite"), nombre: "Capacitación Comité Paritario", tema: "Comité Paritario", horas: "20", metodologia: "presencial", tipoCertificacion: "Certificado OA", vigenciaAnios: 2, tramoMinimo: "mas-25", aplicaA: ["comite_paritario"] },
    ];
    const trabajadorCursos = [
      { id: p("tc-1"), trabajadorId: p("trab-1"), cursoId: p("curso-general"), fechaAprobacion: d(-760), fechaVencimiento: d(-30), certificadoNombre: null, certificadoData: null, fechaCreacion: new Date().toISOString() },
      { id: p("tc-2"), trabajadorId: p("trab-2"), cursoId: p("curso-general"), fechaAprobacion: d(-700), fechaVencimiento: d(30), certificadoNombre: null, certificadoData: null, fechaCreacion: new Date().toISOString() },
      { id: p("tc-3"), trabajadorId: p("trab-3"), cursoId: p("curso-general"), fechaAprobacion: d(-100), fechaVencimiento: d(630), certificadoNombre: "certificado.pdf", certificadoData: "data:application/pdf;base64," + "A".repeat(400), fechaCreacion: new Date().toISOString() },
    ];
    // Documentos del trabajador (carpeta del conductor): uno renovado (con historial), uno por vencer, uno vencido y uno que no vence.
    const td = (n, extra) => Object.assign({ id: p("td-" + n), trabajadorId: p("trab-6"), entidad: "Mandante Ficticio", observacion: "", archivoNombre: null, archivoData: null, reemplazaA: null, reemplazadoPor: null, fechaCreacion: new Date().toISOString() }, extra);
    const trabajadorDocumentos = [
      td(1, { nombre: "Licencia de conducir A3/A5", fechaControl: d(-1500), fechaVencimiento: d(-400), reemplazadoPor: p("td-2") }),
      td(2, { nombre: "Licencia de conducir A3/A5", fechaControl: d(-400), fechaVencimiento: d(1060), reemplazaA: p("td-1"), archivoNombre: "licencia.pdf", archivoData: "data:application/pdf;base64," + "B".repeat(400) }),
      td(3, { nombre: "Examen ocupacional conductor", fechaControl: d(-340), fechaVencimiento: d(25) }),
      td(4, { nombre: "Curso de manejo defensivo", fechaControl: d(-740), fechaVencimiento: d(-10) }),
      td(5, { nombre: "Contrato", entidad: "", fechaControl: d(-200), fechaVencimiento: null }),
    ];
    const doc = (n, tipo, nombre, version, extra) => Object.assign({ id: p("doc-" + n), tipo, subtipo: tipo === "procedimiento" ? "procedimiento" : null, nombre, version, fechaConfeccion: d(-400), fechaRevision: "", fechaActualizacion: d(-400), descripcion: "Documento de prueba", responsableElaboracion: "Pía Prevención Ficticia", responsableRevision: "", responsableAprobacion: "Ada Prueba Admin", observaciones: "", contenido: "Contenido de prueba.", archivoNombre: null, archivoData: null }, extra);
    const documentos = [
      doc(1, "politica", "Política de SST", "1", { fechaActualizacion: d(-500) }),
      doc(2, "politica", "Política de SST", "2", { fechaActualizacion: d(-100), fechaRevision: d(200) }),
      doc(3, "procedimiento", "Procedimiento de trabajo en altura", "1", { fechaRevision: d(-15) }),
      doc(4, "manual", "Manual del sistema de gestión", "3", { fechaActualizacion: d(-60), fechaConfeccion: d(-60) }),
      doc(5, "otro", "Registro sin fechas", "1", { fechaConfeccion: "", fechaActualizacion: "" }),
    ];
    const accidentes = [
      { id: p("acc-1"), tipo: "ctp", fecha: d(-40), areaId: taller, trabajadoresIds: [p("trab-2")], gravedad: "leve", criteriosGrave: [], denunciaRealizada: "si", fechaDenuncia: d(-39), diasPerdidos: 3, sexo: "M", focoCritico: "", causa: "Corte en mano con esmeril (dato de prueba)", descripcion: "Contacto del disco con la mano izquierda al cambiar de pieza.", informePreliminar: null, informePreliminarNombre: null, fotografia: null, investigado: false },
      { id: p("acc-2"), tipo: "trayecto", fecha: d(-12), areaId: terreno, trabajadoresIds: [p("trab-6")], gravedad: "leve", criteriosGrave: [], denunciaRealizada: "", fechaDenuncia: "", diasPerdidos: 0, sexo: "M", focoCritico: "", causa: "Choque por alcance camino a faena (dato de prueba)", descripcion: "Vehículo particular impactado por detrás en semáforo.", informePreliminar: null, informePreliminarNombre: null, fotografia: null, investigado: false },
      { id: p("inc-1"), tipo: "incidente", fecha: d(-5), areaId: terreno, tipoIncidente: "Caída de objetos", focoCritico: "", danioPropiedad: "no", descripcionDanio: "", trabajadoresIds: [], causa: "Herramienta cae desde canastillo (dato de prueba)", descripcion: "Sin lesionados.", gravedad: "leve", criteriosGrave: [], denunciaRealizada: "", fechaDenuncia: "", diasPerdidos: 0, sexo: "", informePreliminar: null, informePreliminarNombre: null, fotografia: null, investigado: false },
    ];
    return {
      id, nombre, stores: {
        empresa: [{ id: "empresa-1", razonSocial: nombre, rut: "76.000.000-0", rubro, numTrabajadores }],
        accesoPerfiles: perfiles, accesoUsuarios: usuarios, areas, trabajadores, programaPersonas, matriz, planAccionMatriz: plan,
        programa, capacitaciones, cursosObligatorios, trabajadorCursos, trabajadorDocumentos, documentos, matrizHistorial: [],
        accidentes, accInvestigaciones: [], arbolesCausales: [], transitoInvestigaciones: [],
      },
    };
  };
  return [
    empresa(PREFIJO + "andes", "Constructora Ficticia Andes SpA (PRUEBA)", "Construcción", 30, "andes"),
    empresa(PREFIJO + "sur", "Servicios Eléctricos Imaginarios Ltda. (PRUEBA)", "Distribución eléctrica", 8, "sur"),
  ];
}

// Inserta las empresas de prueba sin resguardos (lo usan las pruebas
// automáticas sobre una base local desechable).
async function insertar(pool, empresas) {
  for (const e of empresas) {
    await pool.query("INSERT INTO empresas (id, nombre, aprobada) VALUES ($1,$2,true) ON CONFLICT (id) DO NOTHING", [e.id, e.nombre]);
    for (const [store, lista] of Object.entries(e.stores)) {
      for (const r of lista) {
        await pool.query(
          `INSERT INTO records (company_id, store, id, data, updated_at) VALUES ($1,$2,$3,$4, now())
           ON CONFLICT (company_id, store, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
          [e.id, store, r.id, r]
        );
      }
    }
  }
}

// Punto de entrada para staging, con todos los resguardos.
async function sembrarSiCorresponde(pool, { hashPassword }) {
  if (process.env.RENDER_SERVICE_NAME === NOMBRE_SERVICIO_PRODUCCION) throw new Error("este es el servicio de producción: no se siembran datos de prueba");
  const clave = process.env.CLAVE_DATOS_PRUEBA || "";
  if (clave.length < 10) throw new Error("falta CLAVE_DATOS_PRUEBA (mínimo 10 caracteres)");
  const { rows } = await pool.query("SELECT count(*)::int AS n, count(*) FILTER (WHERE company_id LIKE $1)::int AS prueba FROM records", [PREFIJO + "%"]);
  if (rows[0].n > rows[0].prueba) throw new Error("la base de datos tiene registros que no son de prueba: no se siembra nada");
  if (rows[0].prueba > 0) { console.log("Datos de prueba ya sembrados; no se repite."); return false; }
  await insertar(pool, construirEmpresas(hoyChile(), hashPassword(clave)));
  console.log("Datos de prueba sembrados: 2 empresas ficticias (correos *.pehuen-prueba.example, clave = CLAVE_DATOS_PRUEBA).");
  return true;
}

module.exports = { construirEmpresas, insertar, sembrarSiCorresponde, NOMBRE_SERVICIO_PRODUCCION, PREFIJO, hoyChile, isoMas };
