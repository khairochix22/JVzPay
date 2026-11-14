(() => {
  const department = document.getElementById("department_id");
  const position = document.getElementById("position_title");
  if (!department || !position) return;

  const positions = Array.from(position.options).slice(1).map((option) => ({
    value: option.value,
    label: option.textContent,
    departmentId: option.dataset.departmentId,
  }));

  const filterPositions = () => {
    const departmentId = department.value;
    const currentValue = position.value;
    position.replaceChildren(new Option("Choose your position", ""));

    positions
      .filter((item) => item.departmentId === departmentId)
      .forEach((item) => position.add(new Option(item.label, item.value)));

    position.value = positions.some((item) => item.departmentId === departmentId && item.value === currentValue)
      ? currentValue
      : "";
  };

  department.addEventListener("change", filterPositions);
  filterPositions();
})();
