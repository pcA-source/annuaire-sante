/**
 * Cloudflare Pages Function — /api/practitioner?id=xxx
 * Détail d'un praticien
 */

const API_BASE = 'https://gateway.api.esante.gouv.fr/fhir/v2';

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');

  if (!id) return jsonResponse({ error: 'Missing id parameter' }, 400);

  try {
    const practUrl = `${API_BASE}/Practitioner/${id}`;
    const resource = await fhirFetch(practUrl, env);
    const practitioner = parsePractitioner(resource);

    const rolesUrl = `${API_BASE}/PractitionerRole?practitioner=${id}&_include=PractitionerRole:organization&_count=50`;
    const rolesBundle = await fhirFetch(rolesUrl, env);

    const roles = [];
    const orgs = {};

    if (rolesBundle.entry) {
      for (const entry of rolesBundle.entry) {
        if (entry.resource.resourceType === 'PractitionerRole') {
          roles.push(parsePractitionerRole(entry.resource));
        } else if (entry.resource.resourceType === 'Organization') {
          orgs[entry.resource.id] = parseOrganization(entry.resource);
        }
      }
    }

    for (const role of roles) {
      if (role.organizationId && orgs[role.organizationId]) {
        role.organization = orgs[role.organizationId];
      }
    }

    practitioner.roles = roles;
    return jsonResponse(practitioner);
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

function parsePractitioner(resource) {
  const name = resource.name?.[0] || {};
  const identifiers = (resource.identifier || []).map(id => ({
    system: id.system,
    value: id.value,
    type: id.system?.includes('rpps') ? 'RPPS'
      : id.system?.includes('adeli') ? 'ADELI'
      : id.type?.coding?.[0]?.code || 'OTHER',
  }));
  const qualifications = (resource.qualification || []).map(q => ({
    code: q.code?.coding?.[0]?.code,
    display: q.code?.coding?.[0]?.display || q.code?.text,
  }));
  const rpps = identifiers.find(i => i.type === 'RPPS')?.value || null;
  return {
    id: resource.id, rpps, identifiers,
    lastName: name.family || '',
    firstName: (name.given || []).join(' '),
    prefix: (name.prefix || []).join(' '),
    suffix: (name.suffix || []).join(' '),
    qualifications, active: resource.active !== false,
  };
}

function parsePractitionerRole(resource) {
  const specialties = (resource.specialty || []).flatMap(s =>
    (s.coding || []).map(c => c.display || c.code)
  );
  const telecoms = (resource.telecom || []).map(t => ({
    system: t.system, value: t.value, use: t.use,
  }));
  const practRef = resource.practitioner?.reference || '';
  const orgRef = resource.organization?.reference || '';
  return {
    id: resource.id,
    practitionerId: practRef.replace('Practitioner/', ''),
    organizationId: orgRef.replace('Organization/', ''),
    specialties, telecoms, active: resource.active !== false,
  };
}

function parseOrganization(resource) {
  const addr = resource.address?.[0] || null;
  const telecoms = (resource.telecom || []).map(t => ({ system: t.system, value: t.value }));
  return {
    id: resource.id, name: resource.name || '',
    type: resource.type?.[0]?.coding?.[0]?.display || '',
    address: addr ? formatAddress(addr) : null,
    city: addr?.city || null, postalCode: addr?.postalCode || null, telecoms,
  };
}

function formatAddress(addr) {
  if (!addr) return null;
  return [...(addr.line || []), [addr.postalCode, addr.city].filter(Boolean).join(' '), addr.country].filter(Boolean).join(', ');
}

async function fhirFetch(url, env) {
  const res = await fetch(url, {
    headers: { 'Accept': 'application/fhir+json', 'ESANTE-API-KEY': env.ESANTE_API_KEY || '' },
  });
  if (!res.ok) { const body = await res.text(); throw new Error(`FHIR ${res.status}: ${body.substring(0, 200)}`); }
  return res.json();
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}
