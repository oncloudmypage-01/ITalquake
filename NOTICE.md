# ITalquake — licenza e riconoscimenti

ITalquake è software libero: puoi redistribuirlo e/o modificarlo secondo i
termini della GNU General Public License versione 3 o (a tua scelta)
qualsiasi versione successiva, come pubblicata dalla Free Software Foundation.
Il testo completo è nel file `LICENSE`.

ITalquake è distribuito nella speranza che sia utile, ma SENZA ALCUNA
GARANZIA. Le stime mostrate dall'app sono sperimentali e non sostituiscono
le comunicazioni ufficiali di INGV e del Dipartimento della Protezione Civile.

## NESTORE

La stima "Rischio di una forte replica" (`nestore/`, `tools/nestore_train.mjs`)
è un porting in JavaScript di NESTORE (NExt STrOng Related Earthquake),
software dell'Istituto Nazionale di Oceanografia e di Geofisica Sperimentale
(OGS) distribuito sotto GNU GPL v3:

- S. Gentili, P. Brondi, R. Di Giovambattista (2023). *NESTOREv1.0: A MATLAB
  Package for Strong Forthcoming Earthquake Forecasting*. Seismological
  Research Letters 94(4), 2003–2013. doi:10.1785/0220220327
- Codice: https://github.com/StefaniaGentili/NESTORE — Zenodo
  doi:10.5281/zenodo.7472134

Il modello italiano è addestrato da ITalquake sul catalogo INGV; le scelte di
adattamento (area, raggio minimo di 5 km, magnitudo di completezza) sono
descritte in `nestore/report_italia.md`. Non è un prodotto OGS né INGV.

## Dati

- Terremoti, stazioni e forme d'onda: INGV, webservices.ingv.it (CC BY 4.0).
- Segnalazioni "Hai sentito il terremoto?": INGV, hsit.it (CC BY 4.0).
- Catalogo storico CPTI15: INGV (CC BY 4.0). Sorgenti DISS: INGV (CC BY 4.0).
